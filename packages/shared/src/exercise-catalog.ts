import { normalizeExerciseName } from './exercise-match';

import type { ExerciseCatalogDocument } from './schemas';
import type { Connection } from 'mongoose';

// Resolution only, deliberately: the parser upserts a fallback on a miss while
// the edit endpoint refuses the request, so neither policy belongs in here.

export interface CatalogResolution {
  submittedName: string;
  entry: ExerciseCatalogDocument | null;
}

// One `$in` for the whole list because the edit path must report every miss,
// not just the first. Results are positional, duplicates included.
export async function resolveExercisesInCatalog(
  mongoConnection: Connection,
  names: string[],
): Promise<CatalogResolution[]> {
  if (names.length === 0) return [];

  const normalizedByName = new Map(names.map((name) => [name, normalizeExerciseName(name)]));
  const catalog = mongoConnection.model<ExerciseCatalogDocument>('ExerciseCatalog');
  const entries = await catalog
    .find({ normalized_aliases: { $in: [...new Set(normalizedByName.values())] } })
    .lean<ExerciseCatalogDocument[]>();

  const byAlias = new Map<string, ExerciseCatalogDocument>();
  for (const entry of entries) {
    for (const alias of entry.normalized_aliases) {
      if (!byAlias.has(alias)) byAlias.set(alias, entry);
    }
  }

  return names.map((submittedName) => ({
    submittedName,
    entry: byAlias.get(normalizedByName.get(submittedName) as string) ?? null,
  }));
}

export async function resolveExerciseInCatalog(
  mongoConnection: Connection,
  name: string,
): Promise<ExerciseCatalogDocument | null> {
  const [resolution] = await resolveExercisesInCatalog(mongoConnection, [name]);
  return resolution?.entry ?? null;
}
