'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { WorkoutTable } from '@components/workout-table';
import {
  STATUS_NEEDS_REVIEW,
  STATUS_PARSED,
  type WorkoutListResponse,
} from '@lib/contracts/workouts';
import { weekKeyForOffset, weekRangeForOffset } from '@lib/weeks';
import { publishWorkoutDeleted, useWorkoutLog } from '@services/workout-events';
import { deleteWorkout, listWorkouts } from '@services/workouts';

// A week is a bounded window, so it is asked for whole rather than paged. The
// API applies its own DEFAULT_PER_PAGE of 20 when none is given, which would
// silently drop a busy week's 21st workout (FR-007). 100 is the maximum
// `per_page` the contract accepts, and far above any real training week.
const WEEK_PER_PAGE = 100;

export function WeeklyWorkouts({ weeksAgo }: { weeksAgo: number }) {
  const [data, setData] = useState<WorkoutListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const weekRange = useMemo(() => weekRangeForOffset(weeksAgo), [weeksAgo]);

  // Refetch this week when a workout is logged (FR-011). The dashboard has
  // already moved to the workout's week by the time this runs, if it needed to.
  const { revision, isoWeek, changeType } = useWorkoutLog();
  const seenRevision = useRef(revision);

  // See volume-chart.tsx: ignore a response a newer request has superseded.
  const requestSeq = useRef(0);

  /**
   * `replace` says whether the rows on screen are about to be superseded by a
   * different week's, or merely re-read.
   *
   * A week change is a replacement: the rows belong to the week being left, so
   * clearing them is the truthful thing to show while the new week loads. A
   * refetch of the week already on screen is not — blanking there collapses the
   * panel to a "Loading…" line and back on every settled workout, a flicker the
   * reader did not ask for and cannot predict. It is the same distinction
   * workout-list.tsx draws between a page change and a background refetch,
   * where the cost was measured as the scroll position being thrown to 0.
   */
  const load = useCallback(async (monday: Date, sunday: Date, replace: boolean) => {
    const seq = (requestSeq.current += 1);
    setError(null);
    if (replace) setData(null);
    try {
      // GET /workouts is a half-open [after, before) window (contracts/api.md):
      // `before` is exclusive, so it must be the start of the day *after* the
      // week's last day — otherwise every workout on Sunday is dropped.
      const before = new Date(sunday.getTime() + 86_400_000);
      const result = await listWorkouts({
        after: monday.toISOString(),
        before: before.toISOString(),
        per_page: WEEK_PER_PAGE,
        status: [STATUS_NEEDS_REVIEW, STATUS_PARSED],
      });
      if (seq !== requestSeq.current) return;
      setData(result);
    } catch {
      if (seq !== requestSeq.current) return;
      setError('Could not load the workouts for this week. Please try again.');
    }
  }, []);

  // Two effects, not one, and they must stay separate.
  //
  // This first one owns the week the user asked for: the first render, and
  // every arrow press afterwards. It is unconditional, because there is nothing
  // to be conditional about — the week on screen has no data yet.
  //
  // Folding it into the effect below put the `revision` guard in front of it,
  // and `seenRevision` starts equal to `revision`, so neither a mount nor a week
  // change could ever get past it. Measured: /dashboard sat on "Loading…" with
  // zero requests for eight seconds, and pressing "Previous week" moved the
  // label from 14 Sept to 7 Sept with the data untouched. The panel only ever
  // filled in if a notification happened to arrive.
  useEffect(() => {
    // React's documented fetch-in-effect pattern (no data lib in this project).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(weekRange.start, weekRange.end, true);
  }, [weekRange, load]);

  // The second owns changes that came from somewhere else — this tab's own
  // logging, another device, or the worker. Here a guard is right: the user did
  // not ask for anything, so refetch only when the change can actually show up
  // in what is on screen (FR-019).
  //
  // The `revision` comparison is what distinguishes "a change happened" from
  // "React re-ran this effect because one of the other dependencies moved".
  useEffect(() => {
    if (revision === seenRevision.current) return;
    seenRevision.current = revision;

    // Recomputed volume cannot change which workouts exist, only how much they
    // add up to. That is the chart's business, not this list's.
    if (changeType === 'analytics.updated') return;

    // A null week means the change names no single week — a deletion. Refetch
    // rather than skip: the workout that went may well have been this week's,
    // and the store's `isoWeek` note records why the dashboard reads the same
    // null the opposite way.
    if (isoWeek !== null && isoWeek !== weekKeyForOffset(weeksAgo)) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(weekRange.start, weekRange.end, false);
  }, [weekRange, revision, isoWeek, changeType, weeksAgo, load]);

  // Optimistic — see workout-list.tsx for the reasoning; same shape, different
  // container (this one holds the whole response object, not a bare array).
  const remove = useCallback(
    (id: string) => {
      if (data === null) return;
      const index = data.data.findIndex((w) => w.id === id);
      if (index === -1) return;
      const removed = data.data[index];

      setData((current) =>
        current === null
          ? current
          : { ...current, data: current.data.filter((w) => w.id !== id), total: current.total - 1 },
      );

      void deleteWorkout(id).then(
        // The volume chart is counting this workout and has no other way to
        // hear about it (FR-004). Announcing also refetches this list, which is
        // redundant but harmless — the server now agrees with what the row
        // removal above already showed.
        publishWorkoutDeleted,
        () => {
          setData((current) => {
            if (current === null) return current;
            const restored = [...current.data];
            restored.splice(index, 0, removed);
            return { ...current, data: restored, total: current.total + 1 };
          });
          setError('Could not delete that workout. Please try again.');
        },
      );
    },
    [data],
  );

  return (
    <section className="flex flex-col w-full gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium text-black dark:text-zinc-50">Weekly workouts</h2>
      </div>

      {error && (
        <div className="flex items-center justify-between rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void load(weekRange.start, weekRange.end, true)}
            className="font-medium underline"
          >
            Retry
          </button>
        </div>
      )}

      {!error && data === null && <p className="text-sm text-zinc-500">Loading…</p>}

      {/* Rendered even when `error` is set. A failed background refetch lands on
          top of rows that are already correct — hiding them to show the banner
          would undo the flicker fix above by another route. Same reasoning as
          workout-list.tsx. */}
      {data !== null && data.data.length === 0 && (
        <p className="text-sm text-zinc-500">No workouts logged for this week.</p>
      )}

      {data !== null && data.data.length > 0 && (
        <WorkoutTable workouts={data.data} onDelete={remove} />
      )}
    </section>
  );
}
