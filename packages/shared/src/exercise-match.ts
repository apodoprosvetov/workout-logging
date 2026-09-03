// Fold an exercise name to an order- and plural-insensitive key, so that
// "Incline Dumbbell Press", "incline dumbbell bench press" and the user's
// "Dumbbell Bench press incline" all collapse to the same string. Tokens are
// lowercased, stripped of non-alphanumerics, singularized, de-duplicated and
// sorted. The parser worker matches an extracted name against
// exercise_catalog.normalized_aliases (which the seed precomputes the same way),
// so aliases only need one phrasing per equipment variant — not every word
// order (research.md #7).

function singularize(word: string): string {
  if (word.length <= 2) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('yes')) return `${word.slice(0, -3)}y`; // flyes -> fly
  if (/(sses|shes|ches|xes|zes)$/.test(word)) return word.slice(0, -2); // presses -> press
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1); // curls -> curl, ups -> up
  return word;
}

export function normalizeExerciseName(name: string): string {
  const tokens = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(singularize);
  return [...new Set(tokens)].sort().join(' ');
}

// The set of keys a catalog entry should be findable by: its canonical name
// plus every alias, all normalized, de-duplicated.
export function normalizedAliasesFor(name: string, aliases: string[]): string[] {
  return [...new Set([name, ...aliases].map(normalizeExerciseName))].filter(Boolean);
}
