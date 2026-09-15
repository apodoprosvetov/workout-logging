import type { WorkoutStatus } from '@lib/contracts/workouts';

// How a workout's wire values are worded for a reader. Separate from
// lib/contracts/workouts.ts because `'needs_review'` is an API value that must
// not change, while "Needs review" is copy that may — a rewording should not
// touch the file that defines the contract.

const STATUS_LABEL: Record<WorkoutStatus, string> = {
  pending: 'Pending',
  parsed: 'Parsed',
  needs_review: 'Needs review',
  failed: 'Failed',
};

export function statusLabel(status: WorkoutStatus): string {
  return STATUS_LABEL[status];
}
