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
