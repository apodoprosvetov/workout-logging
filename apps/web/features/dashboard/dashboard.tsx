'use client';

import { useEffect, useRef, useState } from 'react';

import { useRequireAuth } from '@hooks/use-require-auth';
import { STATUS_NEEDS_REVIEW, STATUS_PARSED } from '@lib/contracts/workouts';
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

  // The one navigation FR-018 permits. Everything else that arrives refreshes
  // in place — the panels below react to `revision` whatever it was.
  //
  // Keyed on `revision`, not on the date: settling a second workout into the
  // same week must still count as an event, and the user may have navigated
  // away from that week in between.
  const { revision, origin, settledStatus, performedAt } = useWorkoutLog();
  const seenRevision = useRef(revision);

  useEffect(() => {
    if (revision === seenRevision.current) return;
    seenRevision.current = revision;

    // contracts/ui.md lists three conditions, all required. The first two are
    // checked here in the order they are written there; the third is the
    // `target !== weeksAgo` comparison at the bottom, which is the only one
    // this component is in a position to answer.

    // 1. This session performed the logging. `own-workout` is the store's name
    //    for exactly that: a settle naming a workout this tab created. It also
    //    excludes `local` in the same check, which is right — submitting is not
    //    settling. A workout logged on another device is `remote` and must
    //    never pull this screen anywhere (US3 scenario 3).
    if (origin !== 'own-workout') return;

    // 2. It settled to `parsed` or `needs_review`. A `failed` settle has
    //    nowhere to navigate to: the workout stays in the in-flight surface
    //    until dismissed (FR-014), and moving the week would take the user away
    //    from the panel showing them the failure.
    if (settledStatus !== STATUS_PARSED && settledStatus !== STATUS_NEEDS_REVIEW) return;

    // Firing on the settle rather than on submission is what makes this date
    // trustworthy: when the form's date field was left blank, the parser may
    // move the workout to a date it found in the text, and the notification
    // carries where it actually ended up.
    if (performedAt === null) return;

    // Clamped, not ignored: a workout dated in the future has no week to show
    // (FR-003), and one older than the window can only be reached at its edge.
    // Moving as far as we can still tells the user something happened; staying
    // put would look exactly like the bug this requirement exists to fix.
    const target = Math.min(MAX_WEEKS_BACK, Math.max(0, weeksAgoForDate(new Date(performedAt))));
    // Setting state here rather than during render is deliberate: this reacts
    // to an external store changing, which is not information render has.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (target !== weeksAgo) setWeeksAgo(target); // 3. a different week
  }, [revision, origin, settledStatus, performedAt, weeksAgo]);

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
