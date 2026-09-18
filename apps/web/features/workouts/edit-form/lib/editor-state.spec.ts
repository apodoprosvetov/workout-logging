process.env.TZ = 'America/New_York';

import { describe, expect, it } from 'vitest';

import {
  emptyExercise,
  emptySet,
  MAX_EXERCISES,
  MAX_NAME_LENGTH,
  MAX_SETS_PER_EXERCISE,
  MAX_WEIGHT_DECIMALS,
  toEditorState,
  toReplacePayload,
  validateEditorState,
  type EditorState,
} from './editor-state';

import type { WorkoutDetail } from '@lib/contracts/workouts';

const detail: WorkoutDetail = {
  id: 'w1',
  name: 'Push day',
  status: 'parsed',
  source: 'web',
  performed_at: '2026-06-10T14:30:00.000Z',
  exercises: [
    {
      name: 'Incline Dumbbell Press',
      order: 2,
      sets: [
        { order: 2, weight: 30, reps: 8, unit: 'kg' },
        { order: 1, weight: 28, reps: 10, unit: 'kg' },
      ],
    },
    {
      name: 'Barbell Bench Press',
      order: 1,
      sets: [{ order: 1, weight: 80, reps: 5, unit: 'kg' }],
    },
  ],
};

function validState(): EditorState {
  return toEditorState(detail);
}

describe('toEditorState', () => {
  it('sorts exercises and sets by order', () => {
    const state = toEditorState(detail);

    expect(state.exercises.map((e) => e.name)).toEqual([
      'Barbell Bench Press',
      'Incline Dumbbell Press',
    ]);
    expect(state.exercises[1].sets.map((s) => s.weight)).toEqual(['28', '30']);
  });

  it('gives every row a distinct id', () => {
    const state = toEditorState(detail);
    const ids = [
      ...state.exercises.map((e) => e.id),
      ...state.exercises.flatMap((e) => e.sets.map((s) => s.id)),
    ];

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('holds the name and the local wall clock', () => {
    const state = toEditorState(detail);

    expect(state.name).toBe('Push day');
    expect(state.performedAt).toBe('2026-06-10T10:30');
  });

  it('represents a nameless workout as an empty field, not null', () => {
    expect(toEditorState({ ...detail, name: null }).name).toBe('');
  });
});

describe('toReplacePayload', () => {
  it('round-trips a detail back to the same content', () => {
    const payload = toReplacePayload(toEditorState(detail));

    expect(payload).toEqual({
      name: 'Push day',
      performed_at: '2026-06-10T14:30:00.000Z',
      exercises: [
        { name: 'Barbell Bench Press', sets: [{ weight: 80, reps: 5, unit: 'kg' }] },
        {
          name: 'Incline Dumbbell Press',
          sets: [
            { weight: 28, reps: 10, unit: 'kg' },
            { weight: 30, reps: 8, unit: 'kg' },
          ],
        },
      ],
    });
  });

  it('carries no id or order anywhere on the wire', () => {
    const wire = JSON.stringify(toReplacePayload(toEditorState(detail)));

    expect(wire).not.toContain('"id"');
    expect(wire).not.toContain('"order"');
  });

  it('takes order from position, so reordering rows is the whole edit', () => {
    const state = toEditorState(detail);
    state.exercises.reverse();

    expect(toReplacePayload(state).exercises.map((e) => e.name)).toEqual([
      'Incline Dumbbell Press',
      'Barbell Bench Press',
    ]);
  });

  it('keeps the seconds of a date the user never touched', () => {
    const withSeconds = { ...detail, performed_at: '2026-06-10T14:23:45.000Z' };

    expect(toReplacePayload(toEditorState(withSeconds)).performed_at).toBe(
      '2026-06-10T14:23:45.000Z',
    );
  });

  it('takes the typed value once the date is edited', () => {
    const state = toEditorState({ ...detail, performed_at: '2026-06-10T14:23:45.000Z' });
    state.performedAt = '2026-06-11T08:15';

    expect(toReplacePayload(state).performed_at).toBe('2026-06-11T12:15:00.000Z');
  });

  it('sends an empty name as null', () => {
    const state = { ...validState(), name: '   ' };

    expect(toReplacePayload(state).name).toBeNull();
  });

  it('trims what it sends', () => {
    const state = validState();
    state.exercises[0].name = '  Barbell Bench Press  ';

    expect(toReplacePayload(state).exercises[0].name).toBe('Barbell Bench Press');
  });
});

describe('validateEditorState', () => {
  it('accepts a workout read straight from the API', () => {
    expect(validateEditorState(validState())).toEqual([]);
  });

  it('refuses a workout with no exercises', () => {
    const state = { ...validState(), exercises: [] };

    expect(validateEditorState(state)).toContainEqual({
      at: 'form',
      message: 'Add at least one exercise.',
    });
  });

  it('refuses an exercise with no sets, against that exercise', () => {
    const state = validState();
    state.exercises[0].sets = [];

    expect(validateEditorState(state)).toContainEqual({
      at: 'exercise',
      exerciseId: state.exercises[0].id,
      message: 'Add at least one set.',
    });
  });

  it('refuses an unnamed exercise', () => {
    const state = validState();
    state.exercises[0].name = '  ';

    expect(validateEditorState(state)).toContainEqual({
      at: 'exercise',
      exerciseId: state.exercises[0].id,
      message: 'Name this exercise.',
    });
  });

  it('refuses a negative weight but allows a bodyweight set', () => {
    const state = validState();
    const set = state.exercises[0].sets[0];

    set.weight = '-5';
    expect(validateEditorState(state)).toContainEqual({
      at: 'set',
      exerciseId: state.exercises[0].id,
      setId: set.id,
      message: 'Weight cannot be negative.',
    });

    set.weight = '0';
    expect(validateEditorState(state)).toEqual([]);
  });

  it.each([
    ['an empty rep count', '', 'Enter a rep count.'],
    ['a fractional rep count', '8.5', 'Reps must be a whole number of 1 or more.'],
    ['zero reps', '0', 'Reps must be a whole number of 1 or more.'],
    ['a negative rep count', '-3', 'Reps must be a whole number of 1 or more.'],
  ])('refuses %s', (_label, reps, message) => {
    const state = validState();
    const set = state.exercises[0].sets[0];
    set.reps = reps;

    expect(validateEditorState(state)).toContainEqual({
      at: 'set',
      exerciseId: state.exercises[0].id,
      setId: set.id,
      message,
    });
  });

  it.each([
    // A number input accepts exponent notation, which has no '.' to split on.
    ['exponent notation with too many decimals', '1e-3'],
    ['more decimals than the API stores', '80.125'],
  ])('refuses %s', (_label, weight) => {
    const state = validState();
    const set = state.exercises[0].sets[0];
    set.weight = weight;

    expect(validateEditorState(state)).toContainEqual({
      at: 'set',
      exerciseId: state.exercises[0].id,
      setId: set.id,
      message: `Weight takes at most ${MAX_WEIGHT_DECIMALS} decimal places.`,
    });
  });

  // Including weights the spinner arrows cannot reach: they are typed, not
  // stepped, and the API stores them.
  it('accepts every weight the API stores', () => {
    const state = validState();
    for (const weight of ['0', '80', '82.5', '82.25', '82.55', '100', '1e2']) {
      state.exercises[0].sets[0].weight = weight;
      expect(validateEditorState(state)).toEqual([]);
    }
  });

  it('refuses an unusable date', () => {
    const state = { ...validState(), performedAt: 'not a date' };

    expect(validateEditorState(state)).toContainEqual({
      at: 'performedAt',
      message: 'Give the workout a valid date and time.',
    });
  });

  it('refuses a name longer than the API stores', () => {
    const state = { ...validState(), name: 'x'.repeat(MAX_NAME_LENGTH + 1) };

    expect(validateEditorState(state)).toContainEqual({
      at: 'name',
      message: `Keep the name under ${MAX_NAME_LENGTH} characters.`,
    });
  });

  it('refuses an exercise name longer than the API stores', () => {
    const state = validState();
    state.exercises[0].name = 'x'.repeat(MAX_NAME_LENGTH + 1);

    expect(validateEditorState(state)).toContainEqual({
      at: 'exercise',
      exerciseId: state.exercises[0].id,
      message: `Keep the name under ${MAX_NAME_LENGTH} characters.`,
    });
  });

  it('refuses more exercises than the API accepts', () => {
    const state = validState();
    state.exercises = Array.from({ length: MAX_EXERCISES + 1 }, () => {
      const exercise = emptyExercise();
      exercise.name = 'Barbell Bench Press';
      exercise.sets = [{ ...emptySet(), weight: '80', reps: '5' }];
      return exercise;
    });

    expect(validateEditorState(state)).toContainEqual({
      at: 'form',
      message: `A workout can hold at most ${MAX_EXERCISES} exercises.`,
    });
  });

  it('refuses more sets than the API accepts, against that exercise', () => {
    const state = validState();
    state.exercises[0].sets = Array.from({ length: MAX_SETS_PER_EXERCISE + 1 }, () => ({
      ...emptySet(),
      weight: '80',
      reps: '5',
    }));

    expect(validateEditorState(state)).toContainEqual({
      at: 'exercise',
      exerciseId: state.exercises[0].id,
      message: `An exercise can hold at most ${MAX_SETS_PER_EXERCISE} sets.`,
    });
  });

  it('reports every problem, not the first', () => {
    const state = validState();
    state.exercises[0].name = '';
    state.exercises[1].sets[0].reps = '0';

    expect(validateEditorState(state).length).toBeGreaterThan(1);
  });
});
