// Types mirror contracts/api.md's GET /workouts and GET /workouts/:id
// response shapes exactly — apps/web only knows the HTTP contract, not
// apps/api's internal TypeORM entities (plan.md: apps/web never touches the
// DB layer, only calls apps/api over HTTP).

export type WorkoutStatus = 'pending' | 'parsed' | 'needs_review' | 'failed';
export type WorkoutSource = 'web' | 'telegram';
export type SetUnit = 'kg' | 'lb';

export interface WorkoutListItem {
  id: string;
  name: string | null;
  source: WorkoutSource;
  status: WorkoutStatus;
  performed_at: string;
  created_at: string;
}

export interface WorkoutListResponse {
  workouts: WorkoutListItem[];
}

export interface WorkoutSetItem {
  order: number;
  weight: number;
  reps: number;
  unit: SetUnit;
}

export interface WorkoutExerciseItem {
  name: string;
  order: number;
  sets: WorkoutSetItem[];
}

export interface WorkoutDetail {
  id: string;
  name: string | null;
  status: WorkoutStatus;
  source: WorkoutSource;
  performed_at: string;
  exercises: WorkoutExerciseItem[];
}

const STATUS_LABEL: Record<WorkoutStatus, string> = {
  pending: 'Pending',
  parsed: 'Parsed',
  needs_review: 'Needs review',
  failed: 'Failed',
};

const STATUS_BADGE_CLASS: Record<WorkoutStatus, string> = {
  pending: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200',
  parsed: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  needs_review: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
};

export function statusLabel(status: WorkoutStatus): string {
  return STATUS_LABEL[status];
}

export function statusBadgeClass(status: WorkoutStatus): string {
  return STATUS_BADGE_CLASS[status];
}

export function formatPerformedAt(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
