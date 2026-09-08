// Mirrors contracts/api.md's GET /analytics/weekly-volume response shape.
// apps/web only knows the HTTP contract (plan.md).
export interface WeeklyVolume {
  muscle_group: string;
  volume: number;
}

export interface WeeklyVolumeResponse {
  week: string;
  volumes: WeeklyVolume[]; // API returns them sorted by volume desc
}

// ISO 8601 week label (`YYYY-Www`) for a date, in UTC — mirrors
// packages/shared's isoWeekKey. apps/web can't import @workout-logging/shared:
// it's a CommonJS package whose barrel pulls in mongoose/pg/ioredis, none of
// which belong in a browser bundle.
export function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3); // this week's Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// The ISO week `weeksAgo` weeks before the current one (0 = this week).
export function weekKeyForOffset(weeksAgo: number): string {
  return isoWeekKey(new Date(Date.now() - weeksAgo * 7 * 86_400_000));
}

// `D Mon` (e.g. `10 Jun`) for a date, in UTC.
export function formatDayMonth(date: Date): string {
  // en-GB orders day before month ("10 Jun"); en-US would give "Jun 10".
  return date.toLocaleString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// Monday 00:00:00 UTC of the ISO week containing `date`. The one place week
// boundaries are computed, so every caller agrees on where a week starts.
function mondayOfWeek(date: Date): Date {
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday;
}

// First (Monday) and last (Sunday) day of the ISO week `weeksAgo` weeks before
// the current one (0 = this week).
export function weekRangeForOffset(weeksAgo: number): { start: Date; end: Date } {
  const monday = mondayOfWeek(new Date(Date.now() - weeksAgo * 7 * 86_400_000));
  return { start: monday, end: new Date(monday.getTime() + 6 * 86_400_000) };
}

// How many whole ISO weeks back `date` sits from the current week — the
// inverse of weekRangeForOffset, so `weeksAgoForDate(weekRangeForOffset(n).start) === n`.
//
// Computed from Monday to Monday, not by dividing the raw gap: two dates four
// days apart can still be one week apart, or none. Both Mondays are UTC
// midnight, so the difference is an exact multiple of a day and the rounding
// only guards against float drift.
//
// Negative for a date in a future week — the dashboard clamps rather than
// showing weeks that have not happened (FR-003).
export function weeksAgoForDate(date: Date): number {
  const currentMonday = mondayOfWeek(new Date());
  const targetMonday = mondayOfWeek(date);
  return Math.round((currentMonday.getTime() - targetMonday.getTime()) / (7 * 86_400_000));
}
