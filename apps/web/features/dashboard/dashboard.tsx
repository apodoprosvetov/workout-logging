'use client';

import { useEffect, useRef, useState } from 'react';

import { useRequireAuth } from '@hooks/use-require-auth';
import { formatDayMonth } from '@lib/display/date-display';
import { weekRangeForOffset, weeksAgoForDate } from '@lib/weeks';
import { useWorkoutLog } from '@services/workout-events';

import { VolumeChart } from './volume-chart';
import { WeeklyWorkouts } from './weekly-workouts';

const MAX_WEEKS_BACK = 12;

export default function Dashboard() {
  const ready = useRequireAuth();

  const [weeksAgo, setWeeksAgo] = useState(0);

  const weekRange = weekRangeForOffset(weeksAgo);

  // FR-012: a workout logged into a week other than the one on screen pulls the
  // dashboard to its week, so the entry is never saved into apparent silence.
  //
  // Keyed on `revision`, not on the date: logging a second workout into the
  // same week must still count as an event, and the user may have navigated
  // away from that week in between.
  const { revision, lastPerformedAt } = useWorkoutLog();
  const seenRevision = useRef(revision);

  useEffect(() => {
    if (revision === seenRevision.current) return;
    seenRevision.current = revision;
    if (lastPerformedAt === null) return;

    // Clamped, not ignored: a workout dated in the future has no week to show
    // (FR-003), and one older than the window can only be reached at its edge.
    // Moving as far as we can still tells the user something happened; staying
    // put would look exactly like the bug this requirement exists to fix.
    const target = Math.min(
      MAX_WEEKS_BACK,
      Math.max(0, weeksAgoForDate(new Date(lastPerformedAt))),
    );
    // Setting state here rather than during render is deliberate: this reacts
    // to an external store changing, which is not information render has.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (target !== weeksAgo) setWeeksAgo(target);
  }, [revision, lastPerformedAt, weeksAgo]);

  if (!ready) return null;

  return (
    <div className="flex flex-1 flex-col gap-6 bg-zinc-50 px-6 py-10 dark:bg-black">
      <div className="h-10 shrink-0 items-center">
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            aria-label="Previous week"
            disabled={weeksAgo >= MAX_WEEKS_BACK}
            onClick={() => setWeeksAgo((w) => Math.min(MAX_WEEKS_BACK, w + 1))}
            className="rounded px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-100 disabled:opacity-30 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            ‹
          </button>
          <span className="min-w-[4.5rem] text-center text-sm tabular-nums text-zinc-500">
            {formatDayMonth(weekRange.start)} — {formatDayMonth(weekRange.end)}
          </span>
          <button
            type="button"
            aria-label="Next week"
            disabled={weeksAgo <= 0}
            onClick={() => setWeeksAgo((w) => Math.max(0, w - 1))}
            className="rounded px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-100 disabled:opacity-30 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            ›
          </button>
        </div>
      </div>
      <div className="flex-1">
        <div className="flex items-center justify-center gap-2">
          <VolumeChart weeksAgo={weeksAgo} />
        </div>
      </div>
      <div className="flex-1">
        <WeeklyWorkouts weeksAgo={weeksAgo} />
      </div>
    </div>
  );
}
