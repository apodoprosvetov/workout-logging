import { createMongooseConnection } from '@workout-logging/shared';

interface SeedExercise {
  slug: string;
  name: string;
  aliases: string[];
  muscle_groups: string[];
  equipment: string;
}

// Starter set covering the major muscle groups — expanded over time as
// unmatched exercises show up in needs_review workouts (research.md #7).
const EXERCISES: SeedExercise[] = [
  { slug: 'bench-press', name: 'Bench Press', aliases: ['bench press', 'bench', 'flat bench press', 'barbell bench press'], muscle_groups: ['chest', 'triceps', 'shoulders'], equipment: 'barbell' },
  { slug: 'incline-bench-press', name: 'Incline Bench Press', aliases: ['incline bench press', 'incline bench', 'incline press'], muscle_groups: ['chest', 'shoulders', 'triceps'], equipment: 'barbell' },
  { slug: 'overhead-press', name: 'Overhead Press', aliases: ['overhead press', 'ohp', 'military press', 'shoulder press', 'standing press'], muscle_groups: ['shoulders', 'triceps'], equipment: 'barbell' },
  { slug: 'squat', name: 'Squat', aliases: ['squat', 'back squat', 'barbell squat'], muscle_groups: ['quads', 'glutes', 'hamstrings'], equipment: 'barbell' },
  { slug: 'front-squat', name: 'Front Squat', aliases: ['front squat'], muscle_groups: ['quads', 'glutes', 'core'], equipment: 'barbell' },
  { slug: 'deadlift', name: 'Deadlift', aliases: ['deadlift', 'conventional deadlift', 'dl'], muscle_groups: ['back', 'glutes', 'hamstrings'], equipment: 'barbell' },
  { slug: 'romanian-deadlift', name: 'Romanian Deadlift', aliases: ['romanian deadlift', 'rdl', 'stiff leg deadlift'], muscle_groups: ['hamstrings', 'glutes', 'back'], equipment: 'barbell' },
  { slug: 'barbell-row', name: 'Barbell Row', aliases: ['barbell row', 'bent over row', 'bent-over row', 'row'], muscle_groups: ['back', 'biceps'], equipment: 'barbell' },
  { slug: 'pull-up', name: 'Pull-Up', aliases: ['pull-up', 'pull up', 'pullup', 'chin-up', 'chin up'], muscle_groups: ['back', 'biceps'], equipment: 'bodyweight' },
  { slug: 'lat-pulldown', name: 'Lat Pulldown', aliases: ['lat pulldown', 'pulldown'], muscle_groups: ['back', 'biceps'], equipment: 'cable' },
  { slug: 'push-up', name: 'Push-Up', aliases: ['push-up', 'push up', 'pushup'], muscle_groups: ['chest', 'triceps', 'shoulders'], equipment: 'bodyweight' },
  { slug: 'dumbbell-curl', name: 'Dumbbell Curl', aliases: ['dumbbell curl', 'bicep curl', 'db curl'], muscle_groups: ['biceps'], equipment: 'dumbbell' },
  { slug: 'barbell-curl', name: 'Barbell Curl', aliases: ['barbell curl', 'bb curl'], muscle_groups: ['biceps'], equipment: 'barbell' },
  { slug: 'tricep-pushdown', name: 'Tricep Pushdown', aliases: ['tricep pushdown', 'triceps pushdown', 'pushdown'], muscle_groups: ['triceps'], equipment: 'cable' },
  { slug: 'dumbbell-shoulder-press', name: 'Dumbbell Shoulder Press', aliases: ['dumbbell shoulder press', 'db shoulder press'], muscle_groups: ['shoulders', 'triceps'], equipment: 'dumbbell' },
  { slug: 'lateral-raise', name: 'Lateral Raise', aliases: ['lateral raise', 'side raise', 'db lateral raise'], muscle_groups: ['shoulders'], equipment: 'dumbbell' },
  { slug: 'leg-press', name: 'Leg Press', aliases: ['leg press'], muscle_groups: ['quads', 'glutes', 'hamstrings'], equipment: 'machine' },
  { slug: 'leg-curl', name: 'Leg Curl', aliases: ['leg curl', 'hamstring curl'], muscle_groups: ['hamstrings'], equipment: 'machine' },
  { slug: 'leg-extension', name: 'Leg Extension', aliases: ['leg extension'], muscle_groups: ['quads'], equipment: 'machine' },
  { slug: 'plank', name: 'Plank', aliases: ['plank'], muscle_groups: ['core'], equipment: 'bodyweight' },
];

// Upsert by slug so the script is safe to re-run (e.g. after adding new entries).
export async function seedExerciseCatalog(): Promise<number> {
  const connection = await createMongooseConnection();
  const ExerciseCatalog = connection.model('ExerciseCatalog');

  for (const exercise of EXERCISES) {
    await ExerciseCatalog.updateOne({ slug: exercise.slug }, { $set: exercise }, { upsert: true });
  }

  await connection.close();
  return EXERCISES.length;
}

if (require.main === module) {
  seedExerciseCatalog()
    .then((count) => console.log(`Seeded ${count} exercises into exercise_catalog.`))
    .catch((err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    });
}
