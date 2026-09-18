// Matching typed text against the exercise catalog, for suggestions only.
//
// Deliberately NOT the server's matching. apps/api resolves a name through
// normalizeExerciseName (token-sorted, singularized), which apps/web cannot
// import at runtime — the shared barrel would drag ioredis/mongoose into the
// browser bundle — and re-implementing it here would be a second copy that
// drifts silently.
//
// The asymmetry is safe in one direction only, and that is the useful one: a
// suggestion carries a canonical name, which always resolves, so choosing one
// can never produce a 400. The cost is a phrasing the server would accept but
// that is not a literal substring of any alias, which simply gets no
// suggestion — the user types it and saves anyway.

import type { ExerciseCatalogEntry } from '@lib/contracts/exercises';

export function matchCatalogEntries(
  entries: ExerciseCatalogEntry[],
  typed: string,
): ExerciseCatalogEntry[] {
  const needle = typed.trim().toLowerCase();
  // Nothing typed is not "everything matches": an empty field has no intent to
  // suggest against, and dropping the whole catalog under it is noise.
  if (needle === '') return [];

  const matched = entries.filter(
    (entry) =>
      entry.name.toLowerCase().includes(needle) ||
      entry.aliases.some((alias) => alias.toLowerCase().includes(needle)),
  );

  // An entry matching by both its name and two aliases is still one entry.
  const bySlug = new Map(matched.map((entry) => [entry.slug, entry]));
  return [...bySlug.values()];
}
