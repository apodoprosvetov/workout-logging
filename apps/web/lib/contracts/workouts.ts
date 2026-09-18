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

// Which statuses `PUT /workouts/:id` accepts. Part of the contract, not a
// display choice: three surfaces decide whether to offer editing, and a copy
// that drifts would offer an edit the API refuses.
export function isEditableStatus(status: WorkoutStatus): boolean {
  return status === STATUS_PARSED || status === STATUS_NEEDS_REVIEW;
}

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

// `PUT /workouts/:id` — the whole desired end state of a workout, not the
// operations that produce it.
//
// Deliberately NOT the read shapes above with `order` made optional: the
// endpoint rejects a body carrying an explicit `order` for an exercise or a
// set (forbidNonWhitelisted), so order must be expressible only as array
// position. Separate types are what make sending one a type error.

export interface ReplaceWorkoutSet {
  weight: number;
  reps: number;
  unit: SetUnit;
}

export interface ReplaceWorkoutExercise {
  name: string;
  sets: ReplaceWorkoutSet[];
}

export interface ReplaceWorkoutRequest {
  /** null clears the name; the endpoint stores null for an omitted one too. */
  name: string | null;
  /** ISO 8601 instant. */
  performed_at: string;
  exercises: ReplaceWorkoutExercise[];
}
