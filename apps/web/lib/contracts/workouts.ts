import type { Paginated } from './pagination';

// Mirrors contracts/api.md's GET /workouts and GET /workouts/:id response
// shapes exactly — apps/web only knows the HTTP contract, not apps/api's
// internal TypeORM entities (plan.md: apps/web never touches the DB layer,
// only calls apps/api over HTTP).
//
// Wire values only. How a status is worded for a reader lives in
// lib/display/workout-display.ts, how it is coloured in
// lib/ui-styles/workout-styles.ts — neither is part of the contract, and both
// change for reasons that have nothing to do with the API.

export const STATUS_PENDING = 'pending';
export const STATUS_PARSED = 'parsed';
export const STATUS_NEEDS_REVIEW = 'needs_review';
export const STATUS_FAILED = 'failed';

export type WorkoutStatus =
  typeof STATUS_PENDING | typeof STATUS_PARSED | typeof STATUS_NEEDS_REVIEW | typeof STATUS_FAILED;
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

/** `GET /workouts` — a page of list rows in the standard envelope. */
export type WorkoutListResponse = Paginated<WorkoutListItem>;

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
