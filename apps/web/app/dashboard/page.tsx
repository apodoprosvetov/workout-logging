'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, apiJson, clearTokens } from '../../lib/api-client';
import { useRequireAuth } from '../../lib/use-require-auth';
import { formatPerformedAt, statusBadgeClass, statusLabel, type WorkoutListResponse } from '../../lib/workouts';
import { LogWorkoutForm } from './log-workout-form';
import { VolumeChart } from './volume-chart';

export default function DashboardPage() {
  const ready = useRequireAuth();
  const router = useRouter();
  const [workouts, setWorkouts] = useState<WorkoutListResponse['workouts'] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await apiJson<WorkoutListResponse>('/workouts');
      setWorkouts(data.workouts);
    } catch {
      setError('Could not load your workouts. Please try again.');
    }
  }, []);

  const handleDelete = useCallback(
    async (workoutId: string) => {
      try {
        await apiFetch(`/workouts/${workoutId}`, { method: 'DELETE' });
        void load();
      } catch {
        setError('Failed to delete workout. Please try again.');
      }
    },
    [load],
  );

  useEffect(() => {
    // React's own documented "Fetching data" useEffect pattern (no data-fetching
    // library — e.g. SWR/React Query — in this project; that's a bigger call
    // than this page warrants). react-hooks/set-state-in-effect flags this
    // shape generically; there's no library-free alternative for this case.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (ready) void load();
  }, [ready, load]);

  function handleLogout(): void {
    clearTokens();
    router.push('/login');
  }

  if (!ready) return null;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Your workouts</h1>
        <button
          type="button"
          onClick={handleLogout}
          className="text-sm font-medium text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          Log out
        </button>
      </div>

      <LogWorkoutForm onLogged={() => void load()} />

      <VolumeChart />

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium text-black dark:text-zinc-50">History</h2>
        <button
          type="button"
          onClick={() => void load()}
          className="text-sm font-medium text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-center justify-between rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          <span>{error}</span>
          <button type="button" onClick={() => void load()} className="font-medium underline">
            Retry
          </button>
        </div>
      )}

      {workouts === null && !error && <p className="text-sm text-zinc-500">Loading…</p>}

      {workouts !== null && workouts.length === 0 && (
        <p className="text-sm text-zinc-500">No workouts yet — log one to see it here.</p>
      )}

      {workouts !== null && workouts.length > 0 && (
        <ul className="flex flex-col divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {workouts.map((workout) => (
            <li key={workout.id}>
              <div className='flex flex-col'>
              <Link
                href={`/workouts?id=${workout.id}`}
                className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900"
              >
                <div className="flex flex-col">
                  <span className="font-medium text-black dark:text-zinc-50">{workout.name ?? 'Untitled workout'}</span>
                  <span className="text-sm text-zinc-500">{formatPerformedAt(workout.performed_at)}</span>
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(workout.status)}`}>
                  {statusLabel(workout.status)}
                </span>
              </Link>
              <button
                type="button"
                onClick={() => void handleDelete(workout.id)}
                className="w-full rounded-b-lg border-t border-zinc-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100 dark:border-zinc-800 dark:bg-red-950 dark:text-red-300 dark:hover:bg-red-900"
              >
                Delete
              </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
