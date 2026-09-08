import Link from 'next/link';

import {
  formatPerformedAtShort,
  statusBadgeClass,
  statusLabel,
  WORKOUT_ROW_GRID,
  type WorkoutListItem,
} from '@lib/workouts';

// The one definition of a workout list row — date, name, status, delete —
// shared by the dashboard's weekly list and the full history (FR-024).
//
// Presentational only: no state, nothing async. Deleting belongs to whoever
// owns the list, and that owner removes the row optimistically, so there is no
// in-flight window for this component to represent. That is what lets
// `onDelete` honestly be `=> void` — there is no completion to report back.
export function WorkoutTable({
  workouts,
  onDelete,
}: {
  workouts: WorkoutListItem[];
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex flex-col">
      <div className={`${WORKOUT_ROW_GRID} px-1 pb-2 text-xs font-medium uppercase tracking-wide text-zinc-500`}>
        <span>Date</span>
        <span>Workout</span>
        <span>Status</span>
        <span className="sr-only">Delete</span>
      </div>

      {workouts.map((workout) => (
        <div
          key={workout.id}
          className={`${WORKOUT_ROW_GRID} border-t border-zinc-100 px-1 py-2 text-sm dark:border-zinc-800`}
        >
          <span className="text-zinc-500">{formatPerformedAtShort(workout.performed_at)}</span>
          <Link
            href={`/workouts?id=${workout.id}`}
            className="truncate font-medium text-black hover:underline dark:text-zinc-50"
          >
            {workout.name ?? 'Untitled workout'}
          </Link>
          <span
            className={`justify-self-start rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(workout.status)}`}
          >
            {statusLabel(workout.status)}
          </span>
          <button
            type="button"
            onClick={() => onDelete(workout.id)}
            aria-label={`Delete ${workout.name ?? 'workout'}`}
            className="justify-self-end text-zinc-400 hover:text-red-600 dark:hover:text-red-400"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
