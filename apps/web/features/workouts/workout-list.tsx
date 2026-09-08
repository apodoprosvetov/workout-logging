'use client';

import { useCallback, useEffect, useState } from 'react';

import { WorkoutTable } from '@components/workout-table';
import { useRequireAuth } from '@hooks/use-require-auth';
import { FIRST_PAGE } from '@lib/pagination';
import { type WorkoutListResponse } from '@lib/workouts';
import { useWorkoutLog } from '@services/workout-events';
import { deleteWorkout, listWorkouts } from '@services/workouts';

const PER_PAGE = 20;

export function WorkoutList() {
  const ready = useRequireAuth();

  // GET /workouts paginates by page number and answers in the standard envelope
  // (contracts/api.md), so the whole page position is one integer and "is there
  // more?" is `next_page !== null` — no cursor stack, and no over-fetching an
  // extra row to guess at it.
  const [page, setPage] = useState(FIRST_PAGE);
  const [result, setResult] = useState<WorkoutListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (forPage: number) => {
    setError(null);
    setResult(null);
    try {
      setResult(await listWorkouts({ page: forPage, per_page: PER_PAGE }));
    } catch {
      setError('Could not load your workouts. Please try again.');
    }
  }, []);

  // A workout logged from the header belongs at the top of this list, so
  // refetch when one is announced (FR-011). The revision is the dependency —
  // the date is the dashboard's business, not this list's.
  const { revision } = useWorkoutLog();

  useEffect(() => {
    // React's documented fetch-in-effect pattern (no data lib in this project) —
    // same as workout-detail.tsx / weekly-workouts.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (ready) void load(page);
  }, [ready, page, revision, load]);

  // Optimistic: the row goes immediately and comes back if the request fails.
  // That is what keeps WorkoutTable stateless — with no in-flight window there
  // is no "deleting" state for it to hold, so its onDelete can be `=> void`.
  //
  // Index and item are captured here in render scope, before setResult: a state
  // updater must be pure, and StrictMode calls it twice. `total` moves with the
  // row so the "N workouts" count does not lie while the request is in flight.
  const remove = useCallback(
    (id: string) => {
      if (result === null) return;
      const index = result.data.findIndex((w) => w.id === id);
      if (index === -1) return;
      const removed = result.data[index];

      setResult((current) =>
        current === null
          ? current
          : { ...current, data: current.data.filter((w) => w.id !== id), total: current.total - 1 },
      );

      void deleteWorkout(id).catch(() => {
        setResult((current) => {
          if (current === null) return current;
          // splice back at the original position, not the end — the page is
          // ordered by performed_at and appending would scramble it.
          const restored = [...current.data];
          restored.splice(index, 0, removed);
          return { ...current, data: restored, total: current.total + 1 };
        });
        setError('Could not delete that workout. Please try again.');
      });
    },
    [result],
  );

  if (!ready) return null;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-6 py-10">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Workouts</h1>
        {result !== null && (
          <span className="text-sm tabular-nums text-zinc-500">
            {result.total} {result.total === 1 ? 'workout' : 'workouts'}
          </span>
        )}
      </div>

      {error && (
        <div className="flex items-center justify-between rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          <span>{error}</span>
          <button type="button" onClick={() => void load(page)} className="font-medium underline">
            Retry
          </button>
        </div>
      )}

      {!error && result === null && <p className="text-sm text-zinc-500">Loading…</p>}

      {!error && result !== null && result.data.length === 0 && (
        <p className="text-sm text-zinc-500">No workouts logged yet.</p>
      )}

      {!error && result !== null && result.data.length > 0 && (
        <WorkoutTable workouts={result.data} onDelete={remove} />
      )}

      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          onClick={() => result?.prev_page !== null && setPage(result?.prev_page ?? FIRST_PAGE)}
          disabled={result === null || result.prev_page === null}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          ← Newer
        </button>
        <span className="text-xs tabular-nums text-zinc-500">Page {page}</span>
        <button
          type="button"
          onClick={() => result?.next_page != null && setPage(result.next_page)}
          disabled={result === null || result.next_page === null}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          Older →
        </button>
      </div>
    </div>
  );
}
