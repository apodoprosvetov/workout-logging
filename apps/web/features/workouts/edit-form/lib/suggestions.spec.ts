import { describe, expect, it } from 'vitest';

import { matchCatalogEntries } from './suggestions';

import type { ExerciseCatalogEntry } from '@lib/contracts/exercises';

const catalog: ExerciseCatalogEntry[] = [
  {
    slug: 'bench-press',
    name: 'Barbell Bench Press',
    aliases: ['bench press', 'bb bench press', 'flat bench press'],
    muscle_groups: ['chest'],
    equipment: 'barbell',
  },
  {
    slug: 'incline-dumbbell-press',
    name: 'Incline Dumbbell Press',
    aliases: ['incline db press'],
    muscle_groups: ['chest'],
    equipment: 'dumbbell',
  },
  {
    slug: 'ab-wheel-rollout',
    name: 'Ab Wheel Rollout',
    aliases: ['ab rollout', 'ab roller'],
    muscle_groups: ['core'],
    equipment: null,
  },
];

describe('matchCatalogEntries', () => {
  it('matches part of a canonical name', () => {
    expect(matchCatalogEntries(catalog, 'bench').map((e) => e.slug)).toEqual(['bench-press']);
  });

  it('ignores case', () => {
    expect(matchCatalogEntries(catalog, 'INCLINE').map((e) => e.slug)).toEqual([
      'incline-dumbbell-press',
    ]);
  });

  it('matches an alias the canonical name does not contain', () => {
    expect(matchCatalogEntries(catalog, 'bb bench').map((e) => e.slug)).toEqual(['bench-press']);
    expect(matchCatalogEntries(catalog, 'ab roller').map((e) => e.slug)).toEqual([
      'ab-wheel-rollout',
    ]);
  });

  it('returns each entry once however many of its spellings match', () => {
    const matched = matchCatalogEntries(catalog, 'bench press');

    expect(matched).toHaveLength(1);
    expect(matched[0].slug).toBe('bench-press');
  });

  it('returns entries carrying the canonical name to insert', () => {
    expect(matchCatalogEntries(catalog, 'bb bench')[0].name).toBe('Barbell Bench Press');
  });

  it('suggests nothing for an empty or blank field', () => {
    expect(matchCatalogEntries(catalog, '')).toEqual([]);
    expect(matchCatalogEntries(catalog, '   ')).toEqual([]);
  });

  it('suggests nothing when nothing matches', () => {
    expect(matchCatalogEntries(catalog, 'zercher carry')).toEqual([]);
  });

  it('matches several entries when the text is common to them', () => {
    expect(matchCatalogEntries(catalog, 'press').map((e) => e.slug)).toEqual([
      'bench-press',
      'incline-dumbbell-press',
    ]);
  });
});
