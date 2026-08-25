'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiJson } from '../../../lib/api-client';
import { useRequireAuth } from '../../../lib/use-require-auth';
import { formatPerformedAt, statusBadgeClass, statusLabel, type WorkoutDetail as WorkoutDetailData } from '../../../lib/workouts';

export function WorkoutDetail({ id }: { id: string }) {
  const ready = useRequireAuth();
  const [workout, setWorkout] = useState<WorkoutDetailData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setNotFound(false);
    try {
      const data = await apiJson<WorkoutDetailData>(`/workouts/${id}`);
      setWorkout(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setNotFound(true);
        return;
      }
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
      <Link href="/dashboard" className="text-sm font-medium text-zinc-600 underline dark:text-zinc-400">
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
            <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">{workout.name ?? 'Untitled workout'}</h1>
            <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(workout.status)}`}>
              {statusLabel(workout.status)}
            </span>
          </div>
          <p className="text-sm text-zinc-500">
            {formatPerformedAt(workout.performed_at)} · {workout.source === 'telegram' ? 'Telegram' : 'Web'}
          </p>

          {workout.exercises.length === 0 && (
            <p className="text-sm text-zinc-500">
              {workout.status === 'pending' ? 'Still processing — check back shortly.' : 'No exercises were recognized.'}
            </p>
          )}

          {workout.exercises.length > 0 && (
            <ul className="flex flex-col gap-4">
              {workout.exercises
                .slice()
                .sort((a, b) => a.order - b.order)
                .map((exercise) => (
                  <li key={exercise.order} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
                    <h2 className="mb-2 font-medium text-black dark:text-zinc-50">{exercise.name}</h2>
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
