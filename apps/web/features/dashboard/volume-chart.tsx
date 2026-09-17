'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { type WeeklyVolumeResponse } from '@lib/contracts/analytics';
import { weekKeyForOffset } from '@lib/weeks';
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
  // refetch on a log too (FR-011). The refetch at log time still shows no
  // change — a pending workout contributes 0 — but that is no longer where the
  // story ends: the `analytics.updated` that follows the recomputation brings
  // the real figure, which is what this spec added the channel for.
  const { revision, isoWeek } = useWorkoutLog();
  const seenRevision = useRef(revision);

  // Guards against an out-of-order response overwriting a newer one. A workout
  // settling into another week fires two loads in quick succession — one for the
  // week on screen, then one for the week the dashboard follows it to (FR-018's
  // one exception) — and nothing cancels the first. Without this the older,
  // usually empty, response can land last and blank the panel. Seen live during
  // the quickstart pass, when the jump still happened at submission.
  const requestSeq = useRef(0);

  /**
   * `replace` says whether the bars on screen are about to be superseded by a
   * different week's, or merely re-read. See weekly-workouts.tsx for the full
   * reasoning: a week change is a replacement, a refetch of the week already on
   * screen is not, and blanking there makes the panel flicker on every change
   * the reader did not cause.
   */
  const load = useCallback(async (offset: number, replace: boolean) => {
    const seq = (requestSeq.current += 1);
    setError(null);
    if (replace) setData(null);
    try {
      const result = await getWeeklyVolume(weekKeyForOffset(offset));
      if (seq !== requestSeq.current) return;
      setData(result);
    } catch {
      if (seq !== requestSeq.current) return;
      setError('Could not load your weekly volume. Please try again.');
    }
  }, []);

  // Two effects — see weekly-workouts.tsx for the full reasoning; the same
  // split, for the same measured failure. In short: the week the user asked for
  // loads unconditionally, because `seenRevision` starts equal to `revision` and
  // a guard in front of it would block every mount and every arrow press.
  useEffect(() => {
    // React's documented fetch-in-effect pattern (no data lib in this project).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(weeksAgo, true);
  }, [weeksAgo, load]);

  // Changes from elsewhere: refetch only when they land in the week on screen
  // (FR-019). Unlike the weekly list, `analytics.updated` is exactly what this
  // panel exists to react to, so it is not filtered out by type here — only by
  // week.
  useEffect(() => {
    if (revision === seenRevision.current) return;
    seenRevision.current = revision;
    if (isoWeek !== null && isoWeek !== weekKeyForOffset(weeksAgo)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(weeksAgo, false);
  }, [weeksAgo, revision, isoWeek, load]);

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
            onClick={() => void load(weeksAgo, true)}
            className="font-medium underline"
          >
            Retry
          </button>
        </div>
      )}

      {!error && data === null && <p className="text-sm text-zinc-500">Loading…</p>}

      {/* Rendered even when `error` is set — see weekly-workouts.tsx. */}
      {data !== null && data.volumes.length === 0 && (
        <p className="text-sm text-zinc-500">
          No volume for this week yet — matched workouts show up here a moment after parsing.
        </p>
      )}

      {data !== null && data.volumes.length > 0 && (
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
