// Mirrors contracts for `GET /exercises` — the exercise catalog, the same for
// every caller. Wire values only, like the other files here.

export interface ExerciseCatalogEntry {
  /** Stable identifier; the join key the rest of the system uses. */
  slug: string;
  /** The canonical spelling — what an edit submits once a suggestion is chosen. */
  name: string;
  /**
   * Other spellings the API resolves to this entry. Carried so suggestions can
   * match a phrasing that is not the canonical name but still saves.
   */
  aliases: string[];
  muscle_groups: string[];
  equipment: string | null;
}
