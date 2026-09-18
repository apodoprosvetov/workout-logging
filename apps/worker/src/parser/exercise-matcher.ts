import { randomUUID } from 'node:crypto';

import { Exercise, resolveExerciseInCatalog } from '@workout-logging/shared';

import type { Connection } from 'mongoose';
import type { EntityManager } from 'typeorm';

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  // Fallback for names that slugify to nothing (e.g. pure emoji/symbols).
  return slug || randomUUID();
}

export interface MatchResult {
  exercise: Exercise;
  matched: boolean;
}

// research.md #7: match the model's exercise name against
// exercise_catalog.normalized_aliases — an order- and plural-insensitive key
// (exercise-match.ts), so "Dumbbell Bench press incline" finds "Incline
// Dumbbell Press". No match -> the exercise is still recorded (workout is not
// blocked), using a slugified fallback — the caller flags needs_review.
//
// The lookup is shared with apps/api's edit path so both normalize names
// identically; the upsert-on-miss below is this caller's own policy.
export async function matchAndUpsertExercise(
  manager: EntityManager,
  mongoConnection: Connection,
  name: string,
): Promise<MatchResult> {
  const entry = await resolveExerciseInCatalog(mongoConnection, name);

  const slug = entry ? entry.slug : slugify(name);
  const canonicalName = entry ? entry.name : name;

  const exerciseRepository = manager.getRepository(Exercise);
  let exercise = await exerciseRepository.findOneBy({ slug });
  if (!exercise) {
    exercise = await exerciseRepository.save(
      exerciseRepository.create({ slug, name: canonicalName }),
    );
  }

  return { exercise, matched: !!entry };
}
