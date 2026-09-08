'use client';

import { useCallback, useEffect, useState } from 'react';
import { deleteWorkout, listWorkouts } from '@services/workouts';
import { useRequireAuth } from '@hooks/use-require-auth';
import { type WorkoutListItem } from '@lib/workouts';
import { WorkoutTable } from '@components/workout-table';

const PAGE_SIZE = 20;

export function WorkoutList() {
  const ready = useRequireAuth();

  // GET /workouts paginates by `performed_at` desc behind an exclusive `before`
  // cursor (contracts/api.md) — there is no offset or page number. We keep a
  // stack of the `before` value used for each page: cursorStack[0] is undefined
  // (page 1, newest first) and "Older" pushes the last visible row's
  // performed_at; "Newer" pops back.
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const [workouts, setWorkouts] = useState<WorkoutListItem[] | null>(null);
  const [hasNext, setHasNext] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cursor = cursorStack[cursorStack.length - 1];
  const pageIndex = cursorStack.length - 1;

  const load = useCallback(async (before: string | undefined) => {
    setError(null);
    setWorkouts(null);
    try {
      // Over-fetch by one row: the API returns no total or has-more flag, so a
      // full extra row is how we know another page exists.
      const data = await listWorkouts({ limit: PAGE_SIZE + 1, before });
      setHasNext(data.workouts.length > PAGE_SIZE);
      setWorkouts(data.workouts.slice(0, PAGE_SIZE));
    } catch {
      setError('Could not load your workouts. Please try again.');
    }
  }, []);

  useEffect(() => {
    // React's documented fetch-in-effect pattern (no data lib in this project) —
    // same as workout-detail.tsx / weekly-workouts.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (ready) void load(cursor);
  }, [ready, cursor, load]);

  // Optimistic: the row goes immediately and comes back if the request fails.
  // That is what keeps WorkoutTable stateless — with no in-flight window there
  // is no "deleting" state for it to hold, so its onDelete can be `=> void`.
  //
  // Index and item are captured here in render scope, before setWorkouts: a
  // state updater must be pure, and StrictMode calls it twice.
  const remove = useCallback(
    (id: string) => {
      if (workouts === null) return;
      const index = workouts.findIndex((w) => w.id === id);
      if (index === -1) return;
      const removed = workouts[index];

      setWorkouts((current) => current?.filter((w) => w.id !== id) ?? current);

      void deleteWorkout(id).catch(() => {
        setWorkouts((current) => {
          if (current === null) return current;
          // splice back at the original position, not the end — the page is
          // ordered by performed_at and appending would scramble it.
          const restored = [...current];
          restored.splice(index, 0, removed);
          return restored;
        });
        setError('Could not delete that workout. Please try again.');
      });
    },
    [workouts],
  );

  if (!ready) return null;

  const goOlder = () => {
    const last = workouts?.[workouts.length - 1];
    if (last) setCursorStack((s) => [...s, last.performed_at]);
  };
  const goNewer = () => setCursorStack((s) => (s.length > 1 ? s.slice(0, -1) : s));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-6 py-10">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Workouts</h1>

      {error && (
        <div className="flex items-center justify-between rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          <span>{error}</span>
          <button type="button" onClick={() => void load(cursor)} className="font-medium underline">
            Retry
          </button>
        </div>
      )}

      {!error && workouts === null && <p className="text-sm text-zinc-500">Loading…</p>}

      {!error && workouts !== null && workouts.length === 0 && (
        <p className="text-sm text-zinc-500">
          {pageIndex === 0 ? 'No workouts logged yet.' : 'No more workouts on this page.'}
        </p>
      )}

      {!error && workouts !== null && workouts.length > 0 && (
        <WorkoutTable workouts={workouts} onDelete={remove} />
      )}

      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          onClick={goNewer}
          disabled={pageIndex === 0 || workouts === null}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          ← Newer
        </button>
        <span className="text-xs tabular-nums text-zinc-500">Page {pageIndex + 1}</span>
        <button
          type="button"
          onClick={goOlder}
          disabled={!hasNext || workouts === null}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          Older →
        </button>
      </div>
    </div>
  );
}
