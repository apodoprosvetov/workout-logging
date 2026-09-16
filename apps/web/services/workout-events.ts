'use client';

import { useSyncExternalStore } from 'react';

import { isoWeekKey } from '@lib/weeks';

import { loadTokens, subscribeToSession } from './api-client';
import { startEventStream } from './event-stream';

import type {
  ChangeNotification,
  NotificationType,
  SettledWorkoutStatus,
} from '@workout-logging/shared';

// A literal, not `WORKOUT_SETTLED_KEY` imported from @workout-logging/shared.
// The dependency on that package is type-only here, and it has to stay that
// way: its barrel pulls in ioredis, amqplib and mongoose, none of which belong
// in a browser bundle. `import type` is erased before anything resolves, but a
// value import emits a real require — and the failure is not a type error, it
// is `Can't resolve 'dns'` at build time, long after typecheck and the node-env
// tests have both gone green. Same reasoning, and the same shape, as
// NOTIFICATION_TYPES in event-stream.ts and isoWeekKey in lib/weeks.ts.
// `satisfies`, not a `NotificationType` annotation: an annotation widens this
// to the whole union, and then comparing `notification.type` against it narrows
// nothing — `workout_id` and `status` stop existing on the result. This checks
// the literal is a real notification type while leaving it a literal.
const WORKOUT_SETTLED = 'workout.settled' satisfies NotificationType;

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
   * How this change relates to this tab. Three values, and they are ordered
   * from nearest to furthest:
   *
   * `local` — this tab did it and already knows: the logging form submitted, or
   * a row was deleted here. Never a notification.
   *
   * `own-workout` — a notification about a workout this tab logged, coming back
   * from the worker once it settled. Deliberately *not* `local`: this tab did
   * not cause it and did not know it was coming, and the date it carries may
   * differ from the one submitted, because the parser can move a workout to a
   * date it found in the text.
   *
   * `remote` — a notification about anything else: another tab, another device,
   * or a week's volume being recomputed.
   *
   * One field rather than a pair, and this is what the pair could not express:
   * `own-workout` is exactly the case FR-018 permits to move the dashboard, and
   * with a separate boolean beside a two-value origin, "this tab submitted it
   * AND it settled elsewhere" was a state the types allowed and nothing could
   * ever produce. Three named values leave no unreachable fourth.
   *
   * This is also what settles the race T020 recorded. The alternative was to
   * blank the date on every remote change, which breaks the moment T038 starts
   * publishing `workout.created`: this tab's own POST echoes back milliseconds
   * later and would erase the date the week switch depends on. A `created` echo
   * is not a settle, so it does not reach `own-workout`, and nothing has to be
   * destroyed to keep it from navigating.
   */
  readonly origin: 'local' | 'own-workout' | 'remote';

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

  /**
   * The status a `workout.settled` carried, or null for every other change.
   *
   * FR-018's second condition turns on it: a workout that settled to `failed`
   * has nowhere to navigate to — it stays in the in-flight surface until
   * dismissed (FR-014) — so only `parsed` and `needs_review` may move a week.
   * Reported as the fact rather than as a "may navigate" flag, because the rule
   * belongs with the requirement, in the dashboard.
   */
  readonly settledStatus: SettledWorkoutStatus | null;
}

// One frozen object per publish. useSyncExternalStore calls getSnapshot on
// every render and compares by reference, so building a fresh object there
// would re-render forever. Holding one stable reference between publishes
// also makes it safe to use the snapshot itself as an effect dependency.
const INITIAL: WorkoutLogSnapshot = Object.freeze({
  revision: 0,
  // `local` rather than a fourth "nothing has happened yet" value: consumers key
  // off `revision`, which is 0 here and so never fires an effect, making the
  // origin of a change that has not happened unobservable. Adding a value for it
  // would mean every reader handling a case none of them can reach.
  origin: 'local',
  changeType: null,
  performedAt: null,
  isoWeek: null,
  settledStatus: null,
});

// The workouts this tab created and has not yet seen settle.
//
// Small and self-draining: an id goes in when `publishWorkoutLogged` reports a
// successful POST and comes out the moment any `workout.settled` names it —
// including a `failed` one, which must stop being tracked even though it never
// navigates. What can linger is a workout whose settle never arrives at all
// (the worker is down, or the channel missed it while offline); that is bounded
// by how many workouts one person logs in one tab, and the ids go with the tab.
const loggedInThisTab = new Set<string>();

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

/**
 * Replace the snapshot and notify.
 *
 * Takes the whole change as one object rather than a positional list. Most of
 * these fields are `string | null`, so a transposed pair would typecheck
 * cleanly and then be wrong somewhere far away — a week key in the date field
 * silently stops every week filter matching. Named fields also make adding one
 * a compile error at each call site, which is where the decision belongs:
 * whether a deletion has a week is not a question this function can answer.
 */
function publish(change: Omit<WorkoutLogSnapshot, 'revision'>): void {
  snapshot = Object.freeze({ revision: snapshot.revision + 1, ...change });
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
  const settled = notification.type === WORKOUT_SETTLED ? notification : null;

  // A settle closes the book on that workout: whatever it settled to, this tab
  // has no further use for the id. Deleting on `failed` as well as on the two
  // successes is what keeps the set from growing for the rest of the session —
  // and what stops a redelivered settle from being claimed twice, which would
  // navigate a second time long after the user moved on (FR-020).
  const ourWorkout = settled !== null && loggedInThisTab.delete(settled.workout_id);

  publish({
    origin: ourWorkout ? 'own-workout' : 'remote',
    changeType: notification.type,
    performedAt,
    isoWeek: weekOf(notification),
    settledStatus: settled?.status ?? null,
  });
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
 *
 * `workoutId` is what lets this tab recognise its own workout settling, minutes
 * and a worker later, when the notification comes back over a channel every
 * other tab and device is listening to as well (FR-018's first condition).
 *
 * Note what this publish does *not* do: the origin is `local`, not
 * `own-workout`. Submitting is not settling, and the dashboard no longer
 * follows a workout at submission
 * — contracts/ui.md narrowed spec 003's FR-012 to fire when the workout settles
 * instead, which is both the moment the user is watching it in the in-flight
 * surface and the first moment its final date is known.
 */
export function publishWorkoutLogged(workoutId: string, performedAt: string): void {
  loggedInThisTab.add(workoutId);
  publish({
    origin: 'local',
    changeType: null,
    performedAt,
    isoWeek: isoWeekKey(new Date(performedAt)),
    settledStatus: null,
  });
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
  publish({
    origin: 'local',
    changeType: null,
    performedAt: null,
    isoWeek: null,
    settledStatus: null,
  });
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
