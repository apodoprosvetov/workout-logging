import type { Connection } from 'mongoose';
import type { DataSource } from 'typeorm';
import type { ExerciseCatalogDocument } from './schemas';

// ISO 8601 week: weeks start Monday; week 1 is the one containing the year's
// first Thursday. Computed in UTC — `workouts.performed_at` is a timestamptz and
// the parser stores extracted dates as UTC midnight, so UTC weeks are consistent.
export function isoWeekParts(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // shift to this week's Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return { year: d.getUTCFullYear(), week };
}

export function isoWeekKey(date: Date): string {
  const { year, week } = isoWeekParts(date);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// [Monday 00:00 UTC, next Monday 00:00 UTC) for the ISO week containing `date`.
export function isoWeekRange(date: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  return { start, end };
}

export function weeklyVolumeRedisKey(userId: string, isoWeek: string): string {
  return `weekly_volume:${userId}:${isoWeek}`;
}

// Monday 00:00 UTC of the given ISO week (`YYYY-Www`) — the inverse of
// isoWeekKey, for turning a `?week=` query param back into a date to feed
// computeWeeklyVolume. Throws on a malformed string.
export function isoWeekToDate(isoWeek: string): Date {
  const match = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
  if (!match) throw new Error(`invalid ISO week: ${isoWeek}`);
  const year = Number(match[1]);
  const week = Number(match[2]);
  // Jan 4 is always in ISO week 1; walk back to that week's Monday, then forward.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const target = new Date(week1Monday);
  target.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return target;
}

// FR-016: training volume (Σ weight × reps) per muscle group for one user in the
// ISO week containing `weekDate`. Every muscle group an exercise lists gets the
// full set volume (a per-group split is a spec-003 refinement). Sets whose
// exercise has no catalog entry (an unmatched `needs_review` exercise) contribute
// nothing — there's no muscle group to attribute them to.
//
// Shared by the analytics worker (writes the Redis cache) and apps/api's
// Postgres-fallback on a cache miss, so the two can't drift.
export async function computeWeeklyVolume(
  dataSource: DataSource,
  mongoConnection: Connection,
  userId: string,
  weekDate: Date,
): Promise<Record<string, number>> {
  const { start, end } = isoWeekRange(weekDate);
  const rows = (await dataSource.query(
    `SELECT e.slug, s.weight::float AS weight, s.reps
       FROM sets s
       JOIN workout_exercises we ON we.id = s.workout_exercise_id
       JOIN exercises e ON e.id = we.exercise_id
       JOIN workouts w ON w.id = we.workout_id
      WHERE w.user_id = $1
        AND w.status IN ('parsed', 'needs_review')
        AND w.performed_at >= $2
        AND w.performed_at < $3`,
    [userId, start, end],
  )) as Array<{ slug: string; weight: number; reps: number }>;

  if (rows.length === 0) return {};

  const catalog = mongoConnection.model<ExerciseCatalogDocument>('ExerciseCatalog');
  const entries = await catalog
    .find({ slug: { $in: [...new Set(rows.map((r) => r.slug))] } }, { slug: 1, muscle_groups: 1 })
    .lean();
  const groupsBySlug = new Map(entries.map((e) => [e.slug, e.muscle_groups]));

  const volume: Record<string, number> = {};
  for (const row of rows) {
    const groups = groupsBySlug.get(row.slug);
    if (!groups) continue;
    const setVolume = row.weight * row.reps;
    for (const group of groups) {
      volume[group] = (volume[group] ?? 0) + setVolume;
    }
  }
  return volume;
}
