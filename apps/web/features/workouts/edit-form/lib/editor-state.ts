// The pure half of editing a workout: the shape the form holds, the two
// conversions between it and the wire, and the refusals the form can make
// itself. No React and no IO, so all of it is testable without a DOM.
//
// Why the form's own shape at all: `WorkoutDetail` identifies an exercise and
// a set only by `order`, and the replacement body carries no identity at all.
// Keying rows by index or order breaks as soon as one is removed or moved —
// React reuses the wrong input and a half-typed value lands in its neighbour.
// So each row gets an id that exists only while the form is open, and never
// reaches the wire, where order is array position.

import { fromDateTimeLocal, toDateTimeLocal } from '@lib/display/date-display';

import type { ReplaceWorkoutRequest, SetUnit, WorkoutDetail } from '@lib/contracts/workouts';

// Weights and reps are held as the strings the inputs produce, not as numbers:
// an emptied field is `''`, which is a state the user can be in, while `NaN`
// is a state nothing can explain to them. Parsing happens once, in
// toReplacePayload, after validateEditorState has passed.
export interface EditorSet {
  id: string;
  weight: string;
  reps: string;
  unit: SetUnit;
}

export interface EditorExercise {
  id: string;
  name: string;
  sets: EditorSet[];
}

export interface EditorState {
  name: string;
  /** An `<input type="datetime-local">` value — local wall clock, no zone. */
  performedAt: string;
  /**
   * The instant `performedAt` was rendered from. A datetime-local value has no
   * seconds, so sending it back would silently truncate the time of a workout
   * whose date the user never touched.
   */
  performedAtIso: string;
  exercises: EditorExercise[];
}

// The limits apps/api enforces (ReplaceWorkoutDto). Restated rather than
// imported: apps/web may take only types from packages/shared, and these live
// in apps/api anyway. Checking them here turns a 400 the user cannot read into
// a message at the field that caused it.
export const MAX_NAME_LENGTH = 200;
export const MAX_EXERCISES = 50;
export const MAX_SETS_PER_EXERCISE = 100;
export const MAX_WEIGHT_DECIMALS = 2;

let rowSequence = 0;

function rowId(): string {
  // randomUUID is secure-context only, and `next dev` reached over a LAN IP is
  // not one — without the fallback the form fails to build its state at all.
  return globalThis.crypto?.randomUUID?.() ?? `row-${(rowSequence += 1)}`;
}

export function emptySet(unit: SetUnit = 'kg'): EditorSet {
  return { id: rowId(), weight: '', reps: '', unit };
}

export function emptyExercise(): EditorExercise {
  return { id: rowId(), name: '', sets: [emptySet()] };
}

/** A workout as read from the API, as the form holds it. */
export function toEditorState(detail: WorkoutDetail): EditorState {
  return {
    name: detail.name ?? '',
    performedAt: toDateTimeLocal(detail.performed_at),
    performedAtIso: detail.performed_at,
    // Sorted once here so nothing downstream has to care: after this, order is
    // position, exactly as it is on the wire.
    exercises: [...detail.exercises]
      .sort((a, b) => a.order - b.order)
      .map((exercise) => ({
        id: rowId(),
        name: exercise.name,
        sets: [...exercise.sets]
          .sort((a, b) => a.order - b.order)
          .map((set) => ({
            id: rowId(),
            weight: String(set.weight),
            reps: String(set.reps),
            unit: set.unit,
          })),
      })),
  };
}

/**
 * The form's state as the replacement body.
 *
 * Call only on a state `validateEditorState` accepted — this trusts the strings
 * to parse.
 */
export function toReplacePayload(state: EditorState): ReplaceWorkoutRequest {
  const name = state.name.trim();
  return {
    name: name === '' ? null : name,
    performed_at:
      state.performedAt === toDateTimeLocal(state.performedAtIso)
        ? state.performedAtIso
        : fromDateTimeLocal(state.performedAt),
    exercises: state.exercises.map((exercise) => ({
      name: exercise.name.trim(),
      sets: exercise.sets.map((set) => ({
        weight: Number(set.weight),
        reps: Number(set.reps),
        unit: set.unit,
      })),
    })),
  };
}

/**
 * Where a problem belongs on screen. The form renders each one at the field it
 * names, so a refusal is a correction rather than a hunt.
 */
export type EditorProblem =
  | { at: 'form'; message: string }
  | { at: 'name'; message: string }
  | { at: 'performedAt'; message: string }
  | { at: 'exercise'; exerciseId: string; message: string }
  | { at: 'set'; exerciseId: string; setId: string; message: string };

/** Every problem, not the first: the user fixes them in one pass. */
export function validateEditorState(state: EditorState): EditorProblem[] {
  const problems: EditorProblem[] = [];

  if (state.name.trim().length > MAX_NAME_LENGTH) {
    problems.push({ at: 'name', message: `Keep the name under ${MAX_NAME_LENGTH} characters.` });
  }

  if (state.performedAt.trim() === '' || Number.isNaN(new Date(state.performedAt).getTime())) {
    problems.push({ at: 'performedAt', message: 'Give the workout a valid date and time.' });
  }

  if (state.exercises.length === 0) {
    problems.push({ at: 'form', message: 'Add at least one exercise.' });
  }
  if (state.exercises.length > MAX_EXERCISES) {
    problems.push({
      at: 'form',
      message: `A workout can hold at most ${MAX_EXERCISES} exercises.`,
    });
  }

  for (const exercise of state.exercises) {
    const id = exercise.id;

    if (exercise.name.trim() === '') {
      problems.push({ at: 'exercise', exerciseId: id, message: 'Name this exercise.' });
    } else if (exercise.name.trim().length > MAX_NAME_LENGTH) {
      problems.push({
        at: 'exercise',
        exerciseId: id,
        message: `Keep the name under ${MAX_NAME_LENGTH} characters.`,
      });
    }

    if (exercise.sets.length === 0) {
      problems.push({ at: 'exercise', exerciseId: id, message: 'Add at least one set.' });
    }
    if (exercise.sets.length > MAX_SETS_PER_EXERCISE) {
      problems.push({
        at: 'exercise',
        exerciseId: id,
        message: `An exercise can hold at most ${MAX_SETS_PER_EXERCISE} sets.`,
      });
    }

    for (const set of exercise.sets) {
      for (const message of setProblems(set)) {
        problems.push({ at: 'set', exerciseId: id, setId: set.id, message });
      }
    }
  }

  return problems;
}

function setProblems(set: EditorSet): string[] {
  const messages: string[] = [];

  const weight = Number(set.weight);
  if (set.weight.trim() === '' || Number.isNaN(weight)) {
    messages.push('Enter a weight.');
  } else if (weight < 0) {
    // Zero is legitimate — a bodyweight set — so only negatives are refused.
    messages.push('Weight cannot be negative.');
  } else if (hasTooManyDecimals(weight)) {
    messages.push(`Weight takes at most ${MAX_WEIGHT_DECIMALS} decimal places.`);
  }

  const reps = Number(set.reps);
  if (set.reps.trim() === '' || Number.isNaN(reps)) {
    messages.push('Enter a rep count.');
  } else if (!Number.isInteger(reps) || reps < 1) {
    messages.push('Reps must be a whole number of 1 or more.');
  }

  return messages;
}

// Checked on the parsed number, not the typed string: a number input accepts
// `1e-3`, which has no '.' to split on but is still three decimal places.
function hasTooManyDecimals(value: number): boolean {
  const scaled = value * 10 ** MAX_WEIGHT_DECIMALS;
  return !Number.isInteger(Number(scaled.toFixed(6)));
}
