// Immutable list edits for the form's rows. Local to this feature: every other
// list in apps/web is read-only.

export function replaceAt<T>(items: T[], index: number, next: T): T[] {
  const copy = [...items];
  copy[index] = next;
  return copy;
}

export function removeAt<T>(items: T[], index: number): T[] {
  return items.filter((_item, at) => at !== index);
}

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length) return items;
  const copy = [...items];
  const [moved] = copy.splice(from, 1);
  copy.splice(to, 0, moved);
  return copy;
}
