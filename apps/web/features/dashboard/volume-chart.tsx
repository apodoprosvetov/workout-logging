'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { weekKeyForOffset, type WeeklyVolumeResponse } from '@lib/analytics';
import { getWeeklyVolume } from '@services/analytics';
import { useWorkoutLog } from '@services/workout-events';

// FR-017: weekly training volume per muscle group. One measure across ~10
// categories -> a sorted horizontal bar chart (dataviz: magnitude comparison).
// Single series, so no legend — the heading names it; one accent hue for every
// bar (bar length carries the value, colour carries nothing). Labels/values use
// ink tokens, never the bar colour.

function formatVolume(v: number): string {
  return Math.round(v).toLocaleString();
}

export function VolumeChart({ weeksAgo }: { weeksAgo: number }) {
  const [data, setData] = useState<WeeklyVolumeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A logged workout changes this week's volume once the worker parses it, so
  // refetch on a log too (FR-011). Volume for a still-pending workout is 0, so
  // the refetch may show no change yet — that is FR-013, not a bug here.
  const { revision } = useWorkoutLog();

  // Guards against an out-of-order response overwriting a newer one. Logging a
  // workout into another week fires two loads in quick succession — one for the
  // week on screen, then one for the week the dashboard jumps to (FR-012) — and
  // nothing cancels the first. Without this the older, usually empty, response
  // can land last and blank the panel. Seen live during the quickstart pass.
  const requestSeq = useRef(0);

  const load = useCallback(async (offset: number) => {
    const seq = (requestSeq.current += 1);
    setError(null);
    setData(null);
    try {
      const result = await getWeeklyVolume(weekKeyForOffset(offset));
      if (seq !== requestSeq.current) return;
      setData(result);
    } catch {
      if (seq !== requestSeq.current) return;
      setError('Could not load your weekly volume. Please try again.');
    }
  }, []);

  useEffect(() => {
    // React's documented fetch-in-effect pattern (no data lib in this project).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(weeksAgo);
  }, [weeksAgo, revision, load]);

  const max = data && data.volumes.length > 0 ? data.volumes[0].volume : 0;

  return (
    <section className="flex flex-col w-full gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium text-black dark:text-zinc-50">
          Weekly volume by muscle group
        </h2>
      </div>

      {error && (
        <div className="flex items-center justify-between rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void load(weeksAgo)}
            className="font-medium underline"
          >
            Retry
          </button>
        </div>
      )}

      {!error && data === null && <p className="text-sm text-zinc-500">Loading…</p>}

      {!error && data !== null && data.volumes.length === 0 && (
        <p className="text-sm text-zinc-500">
          No volume for this week yet — matched workouts show up here a moment after parsing.
        </p>
      )}

      {!error && data !== null && data.volumes.length > 0 && (
        <ul className="flex flex-col gap-2">
          {data.volumes.map((v) => (
            <li
              key={v.muscle_group}
              className="flex items-center gap-3"
              title={`${v.muscle_group}: ${formatVolume(v.volume)}`}
            >
              <span className="w-24 shrink-0 text-sm capitalize text-zinc-600 dark:text-zinc-400">
                {v.muscle_group}
              </span>
              <span className="h-2.5 flex-1 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
                <span
                  className="block h-full rounded-r bg-blue-600 dark:bg-blue-400"
                  style={{ width: max > 0 ? `${Math.max(2, (v.volume / max) * 100)}%` : '0%' }}
                />
              </span>
              <span className="w-16 shrink-0 text-right text-sm tabular-nums text-zinc-500">
                {formatVolume(v.volume)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        Volume = weight × reps, summed over matched exercises. Bodyweight sets count as 0.
      </p>
    </section>
  );
}
