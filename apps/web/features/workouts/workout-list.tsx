'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { WorkoutTable } from '@components/workout-table';
import { useRequireAuth } from '@hooks/use-require-auth';
import { FIRST_PAGE } from '@lib/contracts/pagination';
import {
  STATUS_NEEDS_REVIEW,
  STATUS_PARSED,
  type WorkoutListResponse,
} from '@lib/contracts/workouts';
import { publishWorkoutDeleted, useWorkoutLog } from '@services/workout-events';
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

  // See volume-chart.tsx: ignore a response that a newer request has already
  // superseded. Here it is paging quickly rather than a week jump, but the
  // failure is the same — the older response lands last and wins.
  const requestSeq = useRef(0);

  const load = useCallback(async (forPage: number) => {
    const seq = (requestSeq.current += 1);
    setError(null);
    // Blank the list only when the answer will be a different set of rows —
    // a page change. Refetching the page already on screen keeps its rows
    // mounted, and that is the whole scroll fix (FR-017).
    //
    // Unmounting them collapses the document to the height of "Loading…", the
    // browser clamps the scroll offset to that shorter page, and the offset does
    // not come back when the rows do. Measured against a real notification with
    // `setResult(null)` here: rows 20 → 0, "Loading…" shown, offset 106 → 0, all
    // within 13ms, and the offset stayed 0 afterwards. Too fast to look like
    // loading and too slow to be invisible — it reads as the page throwing the
    // reader back to the top. This refetch is triggered by a worker settling a
    // workout, not by the reader, so it can land at any moment mid-read.
    //
    // Preferred over saving and restoring window.scrollY because there is
    // nothing to restore *to*: the browser clamps the offset the moment the
    // document shrinks, so the value is already gone by the time a layout effect
    // could read it back. Not unmounting avoids the problem instead of chasing
    // it. What this does not do is keep the reader glued to a particular
    // workout: a newly settled one prepends, every row below shifts down a slot,
    // and the offset stays put — verified. FR-017 asks for the scroll position,
    // and that is what is preserved.
    setResult((current) => (current !== null && current.page === forPage ? current : null));
    try {
      const result = await listWorkouts({
        page: forPage,
        per_page: PER_PAGE,
        status: [STATUS_NEEDS_REVIEW, STATUS_PARSED],
      });
      if (seq !== requestSeq.current) return;
      setResult(result);
    } catch {
      if (seq !== requestSeq.current) return;
      setError('Could not load your workouts. Please try again.');
    }
  }, []);

  // A workout logged from the header belongs at the top of this list, so
  // refetch when one is announced (FR-011). The revision is the dependency —
  // the date is the dashboard's business, not this list's.
  const { revision, changeType } = useWorkoutLog();

  useEffect(() => {
    if (changeType === 'analytics.updated') return;
    // React's documented fetch-in-effect pattern (no data lib in this project) —
    // same as workout-detail.tsx / weekly-workouts.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (ready) void load(page);
  }, [ready, page, revision, changeType, load]);

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

      void deleteWorkout(id).then(
        // Refetching this page is the point, not a side effect: with one row
        // gone the page is short by one, and the reload pulls the next
        // workout up from the following page instead of leaving a gap.
        publishWorkoutDeleted,
        () => {
          setResult((current) => {
            if (current === null) return current;
            // splice back at the original position, not the end — the page is
            // ordered by performed_at and appending would scramble it.
            const restored = [...current.data];
            restored.splice(index, 0, removed);
            return { ...current, data: restored, total: current.total + 1 };
          });
          setError('Could not delete that workout. Please try again.');
        },
      );
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

      {/* Rendered even when `error` is set, unlike the loading line above. An
          error here can arrive on top of a list that is already on screen — a
          background refetch that failed, or a delete that did — and hiding the
          rows to show the banner would collapse the document and lose the
          scroll offset just as surely as unmounting them in `load` would. The
          banner reports the failure; the rows stay readable underneath. */}
      {result !== null && result.data.length === 0 && (
        <p className="text-sm text-zinc-500">No workouts logged yet.</p>
      )}

      {result !== null && result.data.length > 0 && (
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
