'use client';

import { useSyncExternalStore } from 'react';

// Carries "a workout was just logged" from the header's logging form
// (components/log-workout-form.tsx) to whatever lists happen to be mounted:
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
   * Increments once per successful POST /workouts. Consumers keep it in their
   * effect dependencies and refetch when it changes (FR-011).
   */
  readonly revision: number;

  /**
   * Performed date of the workout just logged (ISO 8601), or null when the
   * client does not know it.
   *
   * Null is common, not exceptional: POST /workouts answers
   * `{ workout_id, status }` and nothing more, so this can only be populated
   * from the form's own date field. When the user leaves that field empty the
   * API defaults the date server-side, and the parser worker may later
   * overwrite it with a date found in the text (see `performedAtExplicit` on
   * the Workout entity). Consumers MUST treat null as "unknown" and decide
   * their own fallback — never as "today".
   */
  readonly lastPerformedAt: string | null;
}

// One frozen object per publish. useSyncExternalStore calls getSnapshot on
// every render and compares by reference, so building a fresh object there
// would re-render forever. Holding one stable reference between publishes
// also makes it safe to use the snapshot itself as an effect dependency.
const INITIAL: WorkoutLogSnapshot = Object.freeze({ revision: 0, lastPerformedAt: null });

let snapshot: WorkoutLogSnapshot = INITIAL;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): WorkoutLogSnapshot {
  return snapshot;
}

// apps/web is a static export, so these pages are prerendered at build time
// where nothing has been logged. Returning the same reference as the client's
// initial snapshot keeps hydration from observing a change that never happened.
function getServerSnapshot(): WorkoutLogSnapshot {
  return INITIAL;
}

/**
 * Announce a successfully logged workout.
 *
 * Call exactly once, after POST /workouts succeeds — never on a validation
 * failure, a network error, or dismissal of the form
 * (contracts/ui-routes.md "Producer").
 *
 * `performedAt` is required rather than optional so callers have to decide
 * what they actually know; pass null when the date was not supplied by the
 * user and the server chose it.
 */
export function publishWorkoutLogged(performedAt: string | null): void {
  snapshot = Object.freeze({ revision: snapshot.revision + 1, lastPerformedAt: performedAt });
  // Iterate a copy: a listener may unsubscribe (or a component may mount and
  // subscribe) while React processes the notification.
  for (const listener of [...listeners]) listener();
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
