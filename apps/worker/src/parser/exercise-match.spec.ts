import { describe, expect, it } from 'vitest';

import { normalizeExerciseName, normalizedAliasesFor } from '@workout-logging/shared';

// Pure — no infra, runs in CI (unlike parser.spec.ts).
describe('normalizeExerciseName', () => {
  it('is word-order insensitive', () => {
    const key = normalizeExerciseName('Incline Dumbbell Bench Press');
    expect(normalizeExerciseName('dumbbell bench press incline')).toBe(key);
    expect(normalizeExerciseName('press incline bench dumbbell')).toBe(key);
    // The exact case from the user's real Sept workout that used to miss:
    expect(normalizeExerciseName('Dumbbell Bench press incline')).toBe(key);
  });

  it('is plural insensitive', () => {
    expect(normalizeExerciseName('pull-ups')).toBe(normalizeExerciseName('pull up'));
    expect(normalizeExerciseName('curls')).toBe(normalizeExerciseName('curl'));
    expect(normalizeExerciseName('dips')).toBe(normalizeExerciseName('dip'));
    expect(normalizeExerciseName('barbell rows')).toBe(normalizeExerciseName('row barbell'));
    expect(normalizeExerciseName('lateral raises')).toBe(normalizeExerciseName('lateral raise'));
    expect(normalizeExerciseName('incline bench presses')).toBe(normalizeExerciseName('incline bench press'));
    expect(normalizeExerciseName('triceps pushdown')).toBe(normalizeExerciseName('tricep pushdown'));
  });

  it('does not strip the double-s of "press"', () => {
    expect(normalizeExerciseName('bench press')).toBe('bench press');
  });

  it('collapses punctuation and casing', () => {
    expect(normalizeExerciseName('Close-Grip Bench Press')).toBe(normalizeExerciseName('close grip bench press'));
  });

  it('does not collide distinct movements', () => {
    expect(normalizeExerciseName('barbell row')).not.toBe(normalizeExerciseName('dumbbell row'));
    expect(normalizeExerciseName('incline bench press')).not.toBe(normalizeExerciseName('decline bench press'));
    expect(normalizeExerciseName('front squat')).not.toBe(normalizeExerciseName('back squat'));
  });

  it('de-duplicates repeated tokens', () => {
    expect(normalizeExerciseName('leg press calf press')).toBe('calf leg press');
  });
});

describe('normalizedAliasesFor', () => {
  it('includes the canonical name and every alias, normalized and deduped', () => {
    const keys = normalizedAliasesFor('Incline Dumbbell Press', ['incline db press', 'incline dumbbell bench press']);
    expect(keys).toContain(normalizeExerciseName('Incline Dumbbell Press'));
    expect(keys).toContain(normalizeExerciseName('incline dumbbell bench press'));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
