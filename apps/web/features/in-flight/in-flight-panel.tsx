'use client';

import { STATUS_FAILED, type WorkoutListItem } from '@lib/contracts/workouts';
import { formatPerformedAtShort } from '@lib/display/date-display';
import { statusBadgeClass } from '@lib/ui-styles/workout-styles';

/**
 * The in-flight surface: the user's workouts that are still being processed or
 * have failed (contracts/ui.md, FR-011).
 *
 * Contents only — the <dialog> around it belongs to components/modal.tsx, the
 * same shell LogWorkoutForm sits in. Neither surface drives a dialog of its
 * own; both are panels their host opens. That symmetry is the point: the two
 * are launched from the same control and behave identically, so a reader who
 * has understood one has understood the other.
 *
 * Owns no fetching either. The data arrives from `useInFlight` through the
 * host, which is what lets this be rendered without a network at hand.
 */
export function InFlightPanel({
  items,
  loading,
  error,
  onDismiss,
}: {
  items: readonly WorkoutListItem[];
  loading: boolean;
  error: string | null;
  onDismiss: (id: string) => void;
}) {
  const processing = items.filter((w) => w.status !== STATUS_FAILED);
  const failed = items.filter((w) => w.status === STATUS_FAILED);

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {loading && items.length === 0 && <p className="text-sm text-zinc-500">Loading…</p>}

      {/* FR-015: say so plainly. A blank panel reads as a failure to load,
          which is the one thing this surface exists to rule out. */}
      {!loading && !error && items.length === 0 && (
        <p className="text-sm text-zinc-500">
          Nothing in progress. Workouts you log appear here while they are being read.
        </p>
      )}

      {processing.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">Being read</h3>
          {processing.map((workout) => (
            <InFlightRow key={workout.id} workout={workout}>
              {/* No exercise detail: there is none yet (contracts/ui.md). */}
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(workout.status)}`}
              >
                Reading…
              </span>
            </InFlightRow>
          ))}
        </section>
      )}

      {failed.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Could not be read
          </h3>
          {failed.map((workout) => (
            <InFlightRow key={workout.id} workout={workout}>
              {/* FR-014 wording: dismissing discards the workout, and the button
                  has to say that. "Hide" or "Dismiss" alone would imply it is
                  still somewhere to come back to. */}
              <button
                type="button"
                onClick={() => onDismiss(workout.id)}
                className="shrink-0 rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                Delete
              </button>
            </InFlightRow>
          ))}
          <p className="text-xs text-zinc-500">
            We could not read these. Log them again with clearer text or a sharper photo — deleting
            one removes it for good.
          </p>
        </section>
      )}
    </div>
  );
}

function InFlightRow({
  workout,
  children,
}: {
  workout: WorkoutListItem;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-black dark:text-zinc-50">
          {workout.name ?? 'Untitled workout'}
        </span>
        <span className="text-xs text-zinc-500">
          {formatPerformedAtShort(workout.performed_at)}
        </span>
      </div>
      {children}
    </div>
  );
}
