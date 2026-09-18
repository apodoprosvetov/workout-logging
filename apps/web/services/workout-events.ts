'use client';

import { useSyncExternalStore } from 'react';

import { isoWeekKey } from '@lib/weeks';

import { loadTokens, subscribeToSession } from './api-client';
import { startEventStream } from './event-stream';

import type { ChannelStatus } from './event-stream';
import type {
  ChangeNotification,
  NotificationType,
  SettledWorkoutStatus,
} from '@workout-logging/shared';

// A literal rather than an import: @workout-logging/shared's barrel pulls in
// ioredis/amqplib/mongoose, which fail a browser build with `Can't resolve 'dns'`.
// `satisfies` keeps the type narrow — an annotation would widen it to the union
// and break narrowing on `notification.type`.
const WORKOUT_SETTLED = 'workout.settled' satisfies NotificationType;

// Carries workout-log changes between subtrees that share no parent (the
// header's form, the dashboard panels, /workouts). No data-fetching library
// here, so this module is the seam (docs/specs-archive/003 research #1).
//
// Not a workout cache — it announces changes, consumers refetch.

export interface WorkoutLogSnapshot {
  /** Consumers keep this in effect dependencies and refetch on change (FR-011, FR-004). */
  readonly revision: number;

  /**
   * `local` — this tab did it. `own-workout` — a settle for a workout this tab
   * logged. `remote` — anything else.
   *
   * `own-workout` is the one case FR-018 lets move the dashboard, which is why
   * it is a third value rather than a boolean beside a two-value origin: that
   * pair allowed a state nothing could produce.
   */
  readonly origin: 'local' | 'own-workout' | 'remote';

  /**
   * Null when no notification was involved: a local change, or a reconnect
   * after a gap (FR-023). Consumers drop what cannot concern them (FR-019) —
   * the in-flight surface ignores `analytics.updated`.
   */
  readonly changeType: NotificationType | null;

  /**
   * ISO 8601, or null when the change has no single date (a deletion, an
   * `analytics.updated`, the initial snapshot).
   *
   * Null reads differently per consumer, and both readings are load-bearing:
   * the dashboard treats it as "no week to move to" so a deletion never
   * navigates, while a week-scoped list must treat it as "may concern any
   * week" and refetch, or a deleted workout stays counted (FR-004).
   */
  readonly performedAt: string | null;
  readonly isoWeek: string | null;

  /**
   * Null for everything but a `workout.settled`. FR-018 turns on it: a `failed`
   * settle has nowhere to navigate to, so only `parsed` and `needs_review` may
   * move a week.
   */
  readonly settledStatus: SettledWorkoutStatus | null;
}

// One frozen object per publish: useSyncExternalStore compares by reference,
// so building a fresh object in getSnapshot would re-render forever.
const INITIAL: WorkoutLogSnapshot = Object.freeze({
  revision: 0,
  // No fourth "nothing yet" value: revision 0 never fires an effect, so this is
  // unobservable and a new value would mean readers handling an unreachable case.
  origin: 'local',
  changeType: null,
  performedAt: null,
  isoWeek: null,
  settledStatus: null,
});

// Workouts this tab created and has not yet seen settle. Self-draining: an id
// leaves on any `workout.settled` naming it, `failed` included. One whose settle
// never arrives lingers, bounded by how much one person logs in one tab.
const loggedInThisTab = new Set<string>();

let snapshot: WorkoutLogSnapshot = INITIAL;
const listeners = new Set<() => void>();

// Channel status: a second store, deliberately not part of WorkoutLogSnapshot.
// Every publish bumps `revision` and consumers refetch on it, so folding status
// in would refetch every mounted list on each token-expiry reconnect — four or
// more times an hour. The two meet only at the reconnect bump below.

// `connecting`, not `offline`: nothing has failed before the first attempt, and
// `offline` on load would call data stale at the moment it was fetched.
const INITIAL_STATUS: ChannelStatus = 'connecting';

let channelStatus: ChannelStatus = INITIAL_STATUS;
const statusListeners = new Set<() => void>();

/**
 * Whether delivery was interrupted since the last healthy connection, so the
 * bump fires on a recovery rather than on any arrival at `live` — otherwise
 * every page load's first connect would refetch what the mount just fetched.
 */
let sawGap = false;

function setChannelStatus(next: ChannelStatus): void {
  if (channelStatus === next) return;

  // Armed before the overwrite — both halves read the outgoing value. Two ways
  // to lose delivery: `offline`, and the routine `live` → `connecting` of a
  // token expiring. Redis drops notifications either way (FR-027), so both count.
  if (next === 'offline' || channelStatus === 'live') sawGap = true;

  channelStatus = next;
  for (const listener of [...statusListeners]) listener();

  // After the status listeners: a consumer about to refetch should already see
  // the channel as live.
  if (next === 'live' && sawGap) {
    sawGap = false;
    publishReconnect();
  }
}

export function getChannelStatus(): ChannelStatus {
  return channelStatus;
}

/** Static export: prerender has no session or stream, so hydration must see no change. */
function getServerChannelStatus(): ChannelStatus {
  return INITIAL_STATUS;
}

/** Exported with `getChannelStatus` so the pair can be tested without a DOM. */
export function subscribeToChannelStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/**
 * What a screen may say about the channel (data-model.md, FR-025).
 *
 * Subscribing here does **not** open the channel — only `useWorkoutLog` does.
 * An indicator that opened a stream by rendering would hold connections on
 * screens with nothing to update, against FR-028's per-user cap.
 */
export function useChannelStatus(): ChannelStatus {
  return useSyncExternalStore(subscribeToChannelStatus, getChannelStatus, getServerChannelStatus);
}

let stopStream: (() => void) | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

// The store subscribes to the session, never the reverse: api-client owns
// tokens and must not know this channel exists — and reversing it cycles.
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

// Static export: pages prerender with nothing logged, so returning the client's
// initial reference keeps hydration from seeing a change that never happened.
function getServerSnapshot(): WorkoutLogSnapshot {
  return INITIAL;
}

/**
 * Exported with `getSnapshot` so the store can be tested without a DOM — this
 * project runs no jsdom (plan.md, the Principle II decision).
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
 * One object rather than positional args: most fields are `string | null`, so a
 * transposed pair would typecheck and then break week filtering somewhere far
 * away. Named fields also force each call site to answer a new field.
 */
function publish(change: Omit<WorkoutLogSnapshot, 'revision'>): void {
  snapshot = Object.freeze({ revision: snapshot.revision + 1, ...change });
  // Copy: a listener may subscribe or unsubscribe while React notifies.
  for (const listener of [...listeners]) listener();
}

/**
 * A change from the channel — the worker, or another tab or device.
 *
 * The date is carried, not dropped: a week-scoped list needs it to honour
 * FR-019. Narrowing on the property rather than on the type means a kind added
 * later cannot silently fall into the wrong branch.
 */
function publishRemote(notification: ChangeNotification): void {
  const performedAt = 'performed_at' in notification ? notification.performed_at : null;
  const settled = notification.type === WORKOUT_SETTLED ? notification : null;

  // Deleting on `failed` too, not just the successes: it bounds the set, and it
  // stops a redelivered settle being claimed twice and navigating again (FR-020).
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
 * Deriving the week from the date keeps the list and the chart agreeing on where
 * a week starts (FR-010, SC-004) — `lib/weeks.ts` is the only place that decides.
 *
 * `iso_week` is checked first because `analytics.updated` has no `performed_at`,
 * and a null week means "may concern any week" to every consumer.
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
    onStatus: setChannelStatus,
  });
}

function closeChannel(): void {
  // The listener count dips to zero on every navigation (React unmounts before
  // it mounts), so closing immediately would rebuild the stream per route change.
  closeTimer = setTimeout(() => {
    stopStream?.();
    stopStream = null;
    // A torn-down stream left at `live` is the stale-as-live claim FR-025
    // forbids — reachable by signing out on a dashboard with a healthy channel.
    setChannelStatus(INITIAL_STATUS);
    // After the reset, which arms it: a deliberate teardown is not a gap, and
    // whatever mounts next fetches anyway.
    sawGap = false;
  }, 1000);
}

/**
 * Call exactly once, after POST /workouts succeeds — never on a validation or
 * network failure (contracts/ui-routes.md "Producer").
 *
 * `workoutId` is what lets this tab recognise its own workout settling later
 * (FR-018's first condition). Origin is `local`, not `own-workout`: submitting
 * is not settling, and the dashboard follows a workout only when it settles.
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
 * Call after PUT /workouts/:id succeeds. The edit screen navigates away to the
 * workout it just saved; this is for everything else on screen — the lists and
 * the volume chart, which would otherwise keep showing the workout as it was.
 *
 * Every field is what it is for a reason:
 * - no date and no week, although the new date is known. An edit can move a
 *   workout between weeks, and a named week reaches only the week it moved TO —
 *   the view showing the week it LEFT would drop the announcement and keep
 *   listing it. Null already means "may concern any week" to every consumer.
 * - `local`, not `own-workout`: only a settle may move the dashboard's week
 *   (FR-018), and a screen that jumped because the user saved an edit
 *   elsewhere would be startling.
 * - `changeType: null`: the in-flight surface skips what it does not recognise,
 *   and naming a type here would claim a notification arrived when none did.
 *
 * Shaped identically to publishWorkoutDeleted, and deliberately its own
 * function: the call sites say which happened, and the two need not stay the
 * same if a consumer ever has to tell them apart.
 */
export function publishWorkoutEdited(): void {
  publish({
    origin: 'local',
    changeType: null,
    performedAt: null,
    isoWeek: null,
    settledStatus: null,
  });
}

/**
 * Delivery resumed after a gap (FR-023) — an admission that a change may have
 * been missed, not a change itself. Redis keeps no backlog for an absent
 * listener (FR-027), so asking consumers to refetch is the whole recovery.
 *
 * Every field is chosen to reach all four consumers and move none of them:
 * `changeType: null` because three of them skip `analytics.updated` and any
 * other type would misreport what arrived; null week because naming one would
 * exempt every other; `remote` because `own-workout` is what FR-018 lets move
 * the dashboard, and a screen that jumps on reconnect would be startling.
 */
function publishReconnect(): void {
  publish({
    origin: 'remote',
    changeType: null,
    performedAt: null,
    isoWeek: null,
    settledStatus: null,
  });
}

/**
 * Call after DELETE succeeds. The issuing list already removed the row; this is
 * for everything else on screen, the volume chart especially, which would keep
 * counting a deleted workout (FR-004).
 *
 * No date, deliberately: null stops the dashboard navigating on a deletion
 * (FR-012) while week-scoped lists read it as "may concern any week".
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
