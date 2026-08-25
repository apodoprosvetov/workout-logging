import { Schema } from 'mongoose';

// Field names are snake_case to match the stored document shape (data-model.md).
export interface ExerciseCatalogDocument {
  slug: string;
  name: string;
  aliases: string[];
  muscle_groups: string[];
  equipment: string | null;
}

export const EXERCISE_CATALOG_COLLECTION = 'exercise_catalog';

export const ExerciseCatalogSchema = new Schema<ExerciseCatalogDocument>(
  {
    slug: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    aliases: { type: [String], default: [] },
    muscle_groups: { type: [String], default: [] },
    equipment: { type: String, default: null },
  },
  { collection: EXERCISE_CATALOG_COLLECTION, versionKey: false },
);

// Speeds up the parser's alias lookup (research.md #7).
ExerciseCatalogSchema.index({ aliases: 1 });
