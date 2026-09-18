import type { WorkoutStatus } from '@lib/contracts/workouts';

// Tailwind class strings for workout UI, kept out of lib/contracts/workouts.ts
// — that file's job is mirroring contracts/api.md's response shapes, and a
// class name is not part of any contract. Splitting them means a restyle
// touches only this file, and a contract change only that one.
//
// Shared rather than inlined at each call site because the same workout appears
// in three places (the dashboard's weekly list, the full history, the detail
// page) and a status badge that is amber in one and grey in another reads as a
// bug, not a theme.

const STATUS_BADGE_CLASS: Record<WorkoutStatus, string> = {
  pending: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200',
  parsed: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  needs_review: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
};

export function statusBadgeClass(status: WorkoutStatus): string {
  return STATUS_BADGE_CLASS[status];
}

// Shared column track for the workout list: date | name | status | edit | delete.
// Applied to both the header row and every workout row so the columns line up.
export const WORKOUT_ROW_GRID = 'grid grid-cols-[6.5rem_1fr_auto_2rem_2rem] items-center gap-3';
