'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { useRequireAuth } from '@hooks/use-require-auth';
import { isEditableStatus, type WorkoutDetail as WorkoutDetailData } from '@lib/contracts/workouts';
import { formatPerformedAt } from '@lib/display/date-display';
import { statusLabel } from '@lib/display/workout-display';
import { statusBadgeClass } from '@lib/ui-styles/workout-styles';
import { getWorkout } from '@services/workouts';

export function WorkoutDetail({ id }: { id: string }) {
  const ready = useRequireAuth();
  const [workout, setWorkout] = useState<WorkoutDetailData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setNotFound(false);
    // Drop the previous workout before fetching. `load` is keyed on `id`, so
    // navigating from one workout to another re-runs this — without the reset
    // the old workout stays painted, under the new id, until the fetch lands
    // (T039). Clearing it puts the panel back into its loading state instead.
    setWorkout(null);
    try {
      // null means "no such workout to show" — see getWorkout; anything that
      // actually went wrong still throws.
      const data = await getWorkout(id);
      if (data === null) {
        setNotFound(true);
        return;
      }
      setWorkout(data);
    } catch {
      setError('Could not load this workout. Please try again.');
    }
  }, [id]);

  useEffect(() => {
    // See dashboard/page.tsx's identical comment — React's own documented
    // "Fetching data" useEffect pattern, no data-fetching library in this project.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (ready) void load();
  }, [ready, load]);

  if (!ready) return null;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-10">
      <Link
        href="/workouts"
        className="text-sm font-medium text-zinc-600 underline dark:text-zinc-400"
      >
        ← Back to workouts
      </Link>

      {notFound && <p className="text-sm text-zinc-500">Workout not found.</p>}

      {error && (
        <div className="flex items-center justify-between rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          <span>{error}</span>
          <button type="button" onClick={() => void load()} className="font-medium underline">
            Retry
          </button>
        </div>
      )}

      {!workout && !notFound && !error && <p className="text-sm text-zinc-500">Loading…</p>}

      {workout && (
        <div className="flex flex-col gap-6">
          <div className="flex items-center justify-between gap-4">
            <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
              {workout.name ?? 'Untitled workout'}
            </h1>
            <span
              className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(workout.status)}`}
            >
              {statusLabel(workout.status)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-zinc-500">
              {formatPerformedAt(workout.performed_at)} ·{' '}
              {workout.source === 'telegram' ? 'Telegram' : 'Web'}
            </p>
            {isEditableStatus(workout.status) && (
              <Link
                href={`/workouts/edit?id=${workout.id}`}
                className="shrink-0 rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                Edit
              </Link>
            )}
          </div>

          {workout.exercises.length === 0 && (
            <p className="text-sm text-zinc-500">
              {workout.status === 'pending'
                ? 'Still processing — check back shortly.'
                : 'No exercises were recognized.'}
            </p>
          )}

          {workout.exercises.length > 0 && (
            <ul className="flex flex-col gap-4">
              {workout.exercises
                .slice()
                .sort((a, b) => a.order - b.order)
                .map((exercise) => (
                  <li
                    key={exercise.order}
                    className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
                  >
                    <h2 className="mb-2 font-medium text-black dark:text-zinc-50">
                      {exercise.name}
                    </h2>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-zinc-500">
                          <th className="font-normal">Set</th>
                          <th className="font-normal">Weight</th>
                          <th className="font-normal">Reps</th>
                        </tr>
                      </thead>
                      <tbody>
                        {exercise.sets
                          .slice()
                          .sort((a, b) => a.order - b.order)
                          .map((set) => (
                            <tr key={set.order} className="text-black dark:text-zinc-50">
                              <td>{set.order}</td>
                              <td>
                                {set.weight} {set.unit}
                              </td>
                              <td>{set.reps}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
