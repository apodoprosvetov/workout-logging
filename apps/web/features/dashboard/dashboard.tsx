'use client';

import { useState } from "react";

import { useRequireAuth } from "@hooks/use-require-auth";
import { formatDayMonth, weekRangeForOffset } from "@lib/analytics";
import { VolumeChart } from "./volume-chart";
import { WeeklyWorkouts } from "./weekly-workouts";

const MAX_WEEKS_BACK = 12;

export default function Dashboard() {
  const ready = useRequireAuth();

  const [weeksAgo, setWeeksAgo] = useState(0);

  const weekRange = weekRangeForOffset(weeksAgo);

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