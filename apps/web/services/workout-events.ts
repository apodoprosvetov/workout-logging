'use client';

import { useSyncExternalStore } from 'react';

import { isoWeekKey } from '@lib/weeks';

import { loadTokens, subscribeToSession } from './api-client';
import { startEventStream } from './event-stream';

import type { ChangeNotification, NotificationType } from '@workout-logging/shared';

// Carries "a workout was just logged" from the header's logging form
// (features/log-workout/log-workout-form.tsx) to whatever lists are mounted:
// the dashboard's weekly list and volume chart, and the full history on
// /workouts. Those live in different subtrees with no common parent to hold
// the state, and this project has no data-fetching library, so this module is
// the seam between them (specs/003 research #1, contracts/ui-routes.md
// "Logged-workout signal").
//
// Same primitive and same reasoning as the token store behind
// services/use-require-auth.ts: external mutable state belongs behind
// useSyncExternalStore rather than useState + useEffect.
//
// Deliberately NOT a general workout cache. It announces newly logged
// workouts only — the later pending -> parsed transition produced by the
// worker is out of scope by contract (FR-013) and gets its own spec. When
// that lands, this module is the single place that gets replaced.

export interface WorkoutLogSnapshot {
  /**
   * Increments once per change to the workout log — a workout created, or one
   * deleted. Consumers keep it in their effect dependencies and refetch when it
   * changes (FR-011, FR-004).
   */
  readonly revision: number;

  /**
   * Who caused this change.
   *
   * `local` — this tab did it: the logging form, or a delete this tab issued.
   * `remote` — it arrived over the notification channel, from the worker or
   * from this user's other tab or device.
   *
   * This is the field that keeps FR-018 honest. Only the session that logged a
   * workout may follow it to its week, so the dashboard checks `origin` before
   * acting on `performedAt` — a workout logged on another device must never
   * pull this screen anywhere (US3 scenario 3).
   *
   * It also settles the race T020 recorded. The alternative was to blank the
   * date on every remote change, which breaks the moment T038 starts publishing
   * `workout.created`: this tab's own POST echoes back milliseconds later and
   * would erase the date its week switch depends on. Judging by origin needs no
   * such blanking, so the echo is simply ignored instead of destructive.
   */
  readonly origin: 'local' | 'remote';

  /**
   * Which kind of notification this was, or null for a local change — local
   * changes are not notifications and have no type to report.
   *
   * Consumers use it to drop what cannot concern them (FR-019): the in-flight
   * surface ignores `analytics.updated`, since recomputed volume cannot change
   * which workouts are still being processed.
   */
  readonly changeType: NotificationType | null;

  /**
   * The `performed_at` of the workout this change concerns (ISO 8601), or null
   * when the change has no single date: a deletion, an `analytics.updated`
   * (which carries `iso_week` instead), or the initial snapshot.
   *
   * For a local log it is read from `POST /workouts`'s response, which returns
   * the date it stored (contracts/api.md), rather than recomputed here: with
   * the form's date field left blank the server picks the date, and a client
   * that reimplemented that rule would be duplicating a decision that is the
   * server's. For a remote change it is the notification's own `performed_at`.
   *
   * One limitation it cannot cover for a local log: when the date was not set
   * explicitly, the parser may later move the workout to a date found in the
   * text (`performedAtExplicit` on the Workout entity). This says where the
   * workout landed at creation; the `workout.settled` notification that follows
   * carries where it ended up.
   *
   * Null is meaningful to consumers, not merely absent, and the two readings
   * differ by consumer. The dashboard treats it as "no week to move to", so a
   * deletion never navigates. A week-scoped list must treat it as "may concern
   * any week" and refetch: a deletion genuinely changes a week it cannot name,
   * and skipping it would leave the removed workout counted (FR-004).
   */
  readonly performedAt: string | null;
  readonly isoWeek: string | null;
}

// One frozen object per publish. useSyncExternalStore calls getSnapshot on
// every render and compares by reference, so building a fresh object there
// would re-render forever. Holding one stable reference between publishes
// also makes it safe to use the snapshot itself as an effect dependency.
const INITIAL: WorkoutLogSnapshot = Object.freeze({
  revision: 0,
  // `local` rather than a third "nothing has happened" value: consumers key off
  // `revision`, which is 0 here and so never fires an effect, making the origin
  // of a change that has not happened unobservable. A third value would have to
  // be handled in every switch for a state no consumer can reach.
  origin: 'local',
  changeType: null,
  performedAt: null,
  isoWeek: null,
});

let snapshot: WorkoutLogSnapshot = INITIAL;
const listeners = new Set<() => void>();

let stopStream: (() => void) | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

// The store subscribes to the session, never the other way round: api-client
// owns tokens and must not know a notification channel exists. Reversing this
// also creates an import cycle, since the channel reaches apiFetch.
subscribeToSession(() => {
  if (!loadTokens()) {
    closeChannel();
  } else if (listeners.size > 0) {
    // Signing back in: consumers are already mounted, so `subscribe` will not
    // fire again and nothing would reopen the channel until a page reload.
    openChannel();
  }
});

export function getSnapshot(): WorkoutLogSnapshot {
  return snapshot;
}

// apps/web is a static export, so these pages are prerendered at build time
// where nothing has been logged. Returning the same reference as the client's
// initial snapshot keeps hydration from observing a change that never happened.
function getServerSnapshot(): WorkoutLogSnapshot {
  return INITIAL;
}

/**
 * The `useSyncExternalStore` subscribe half — exported alongside `getSnapshot`
 * because together they *are* this store's contract; `useWorkoutLog` is only a
 * convenience wrapper over them. Exported rather than kept private so the
 * store's behaviour can be exercised without a DOM: this project deliberately
 * runs no jsdom or component rendering (plan.md, the Principle II decision).
 */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    openChannel();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      closeChannel();
    }
  };
}

function publish(
  origin: WorkoutLogSnapshot['origin'],
  changeType: NotificationType | null,
  performedAt: string | null,
  isoWeek: string | null,
): void {
  snapshot = Object.freeze({
    revision: snapshot.revision + 1,
    origin,
    changeType,
    performedAt,
    isoWeek,
  });
  // Iterate a copy: a listener may unsubscribe (or a component may mount and
  // subscribe) while React processes the notification.
  for (const listener of [...listeners]) listener();
}

/**
 * A change that arrived over the notification channel — from the worker, or
 * from this user's other tab or device.
 *
 * The notification's date is carried rather than discarded: a week-scoped list
 * cannot honour FR-019 ("ignore notifications about data it is not currently
 * displaying") without knowing which week the change landed in. What stops it
 * from also moving the dashboard is `origin`, not a missing date — see the
 * field's note.
 *
 * `analytics.updated` is the one kind with no `performed_at`; it identifies its
 * week by `iso_week` instead. Narrowing on the property rather than on
 * `type !== 'analytics.updated'` means a notification kind added later cannot
 * silently fall into the wrong branch — the discriminated union makes the
 * compiler check it.
 */
function publishRemote(notification: ChangeNotification): void {
  const performedAt = 'performed_at' in notification ? notification.performed_at : null;
  publish('remote', notification.type, performedAt, weekOf(notification));
}

/**
 * Which week a notification lands in, however it happens to say so.
 *
 * Two sources, never both on one notification: `analytics.updated` names its
 * week directly, every other kind carries a date this derives the week from.
 * Deriving from the date rather than trusting a second server field is what
 * keeps the weekly list and the volume chart agreeing about where a week starts
 * (FR-010, SC-004) — `lib/weeks.ts` is the only place that decides it, for the
 * dashboard's boundaries and for this alike.
 *
 * Reading `iso_week` first matters: `analytics.updated` has no `performed_at`,
 * so checking the date first would leave its week null, and a null week means
 * "may concern any week" to every consumer. That is exactly what happened
 * before this existed — the chart refetched a recomputation seventeen weeks
 * away from the one on screen.
 */
function weekOf(notification: ChangeNotification): string | null {
  if ('iso_week' in notification) return notification.iso_week;
  if ('performed_at' in notification) return isoWeekKey(new Date(notification.performed_at));
  return null;
}

function openChannel(): void {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }

  if (stopStream) return;

  stopStream = startEventStream({
    onNotification: publishRemote,
  });
}

function closeChannel(): void {
  // React unmounts the old page's consumers before mounting the new page's, so
  // the count dips to zero on every navigation. Closing immediately would tear
  // the stream down and rebuild it on each route change.
  closeTimer = setTimeout(() => {
    stopStream?.();
    stopStream = null;
  }, 1000);
}

/**
 * Announce a successfully logged workout.
 *
 * Call exactly once, after POST /workouts succeeds — never on a validation
 * failure, a network error, or dismissal of the form
 * (contracts/ui-routes.md "Producer").
 *
 * `performedAt` is required rather than optional so the caller has to state
 * where the workout landed — see the field's note for how the form knows it
 * even when the user left the date blank.
 */
export function publishWorkoutLogged(performedAt: string): void {
  publish('local', null, performedAt, isoWeekKey(new Date(performedAt)));
}

/**
 * Announce a successfully deleted workout.
 *
 * Call after DELETE /workouts/:id succeeds. The list that issued the delete has
 * already removed the row optimistically — this is for everything *else* on
 * screen, and the weekly volume chart in particular: without it the chart keeps
 * counting a workout that no longer exists, and the two dashboard panels stop
 * describing the same week (FR-004, spec.md Edge Cases).
 *
 * No date, deliberately. `performedAt` stays null so the dashboard's
 * week-switching rule (FR-012) ignores a deletion — deleting a workout must
 * refresh the week on screen, never navigate away from it. A week-scoped list
 * reads the same null the other way and refetches anyway, which is what it has
 * to do: the deleted workout may well have been in the week on screen.
 */
export function publishWorkoutDeleted(): void {
  publish('local', null, null, null);
}

/**
 * Subscribe to logged-workout announcements.
 *
 * The returned object is stable between publishes, so either it or its
 * `revision` field works as an effect dependency.
 */
export function useWorkoutLog(): WorkoutLogSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
