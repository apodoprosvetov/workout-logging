'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { WorkoutTable } from '@components/workout-table';
import { weekRangeForOffset } from '@lib/analytics';
import { type WorkoutListResponse } from '@lib/workouts';
import { useWorkoutLog } from '@services/workout-events';
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
  const { revision } = useWorkoutLog();

  const load = useCallback(async (monday: Date, sunday: Date) => {
    setError(null);
    setData(null);
    try {
      // GET /workouts is a half-open [after, before) window (contracts/api.md):
      // `before` is exclusive, so it must be the start of the day *after* the
      // week's last day — otherwise every workout on Sunday is dropped.
      const before = new Date(sunday.getTime() + 86_400_000);
      setData(
        await listWorkouts({
          after: monday.toISOString(),
          before: before.toISOString(),
          per_page: WEEK_PER_PAGE,
        }),
      );
    } catch {
      setError('Could not load the workouts for this week. Please try again.');
    }
  }, []);

  useEffect(() => {
    // React's documented fetch-in-effect pattern (no data lib in this project).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(weekRange.start, weekRange.end);
  }, [weekRange, revision, load]);

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

      void deleteWorkout(id).catch(() => {
        setData((current) => {
          if (current === null) return current;
          const restored = [...current.data];
          restored.splice(index, 0, removed);
          return { ...current, data: restored, total: current.total + 1 };
        });
        setError('Could not delete that workout. Please try again.');
      });
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
            onClick={() => void load(weekRange.start, weekRange.end)}
            className="font-medium underline"
          >
            Retry
          </button>
        </div>
      )}

      {!error && data === null && <p className="text-sm text-zinc-500">Loading…</p>}

      {!error && data !== null && data.data.length === 0 && (
        <p className="text-sm text-zinc-500">No workouts logged for this week.</p>
      )}

      {!error && data !== null && data.data.length > 0 && (
        <WorkoutTable workouts={data.data} onDelete={remove} />
      )}
    </section>
  );
}
