import { createMongooseConnection } from './mongoose';
import { normalizedAliasesFor } from '../exercise-match';

export interface SeedExercise {
  slug: string;
  name: string;
  aliases: string[];
  muscle_groups: string[];
  equipment: string | null;
}

// Muscle-group vocabulary (data-model.md): chest, triceps, shoulders, back,
// biceps, forearms, quads, glutes, hamstrings, calves, core. The analytics
// worker attributes each set's volume to every group listed here, so keep the
// list consistent — a new group only means adding it here and to the vocab.
//
// slug is the stable join key with the Postgres `exercises` table. The 20
// entries that existed before the 2026-09-03 expansion keep their original
// slug even though their display name/aliases were rewritten, so already-parsed
// workouts don't orphan.
//
// Aliases only need one phrasing per equipment variant, not every word order:
// the parser matches on token-sorted, singularized keys (exercise-match.ts).
const EXERCISES: SeedExercise[] = [
  // ---- Chest / horizontal & incline press ----
  { slug: 'bench-press', name: 'Barbell Bench Press', aliases: ['bench press', 'bench presses', 'bb bench press', 'barbell bench', 'flat bench press', 'chest press barbell'], muscle_groups: ['chest', 'triceps', 'shoulders'], equipment: 'barbell' },
  { slug: 'dumbbell-bench-press', name: 'Dumbbell Bench Press', aliases: ['db bench press', 'flat dumbbell press', 'dumbbell chest press', 'db bench', 'dumbbell press', 'dumbbell bench presses'], muscle_groups: ['chest', 'triceps', 'shoulders'], equipment: 'dumbbell' },
  { slug: 'incline-bench-press', name: 'Barbell Incline Bench Press', aliases: ['incline barbell press', 'incline bench press', 'incline bb press', 'barbell incline press', 'incline bench presses'], muscle_groups: ['chest', 'shoulders', 'triceps'], equipment: 'barbell' },
  { slug: 'incline-dumbbell-press', name: 'Incline Dumbbell Press', aliases: ['incline db press', 'incline dumbbell bench press', 'db incline press', 'incline chest press db', 'incline presses'], muscle_groups: ['chest', 'shoulders', 'triceps'], equipment: 'dumbbell' },
  { slug: 'machine-chest-press', name: 'Machine Chest Press', aliases: ['chest press machine', 'seated chest press', 'machine bench press'], muscle_groups: ['chest', 'triceps', 'shoulders'], equipment: 'machine' },
  { slug: 'close-grip-bench-press', name: 'Close-Grip Bench Press', aliases: ['cgbp', 'close grip bench press', 'close grip barbell press', 'tricep bench press'], muscle_groups: ['triceps', 'chest', 'shoulders'], equipment: 'barbell' },
  { slug: 'push-up', name: 'Push-up', aliases: ['push up', 'pushups', 'push-ups', 'bodyweight pushup', 'press up', 'press ups'], muscle_groups: ['chest', 'triceps', 'shoulders', 'core'], equipment: 'bodyweight' },
  { slug: 'dips', name: 'Dips', aliases: ['dip', 'dips', 'tricep dips', 'triceps dips', 'bodyweight dips', 'parallel bar dips', 'chest dips'], muscle_groups: ['triceps', 'chest', 'shoulders'], equipment: 'bodyweight' },
  { slug: 'cable-chest-fly', name: 'Cable Chest Fly', aliases: ['cable fly', 'cable flies', 'cable crossover', 'crossover', 'chest fly cable', 'cable chest flyes'], muscle_groups: ['chest', 'shoulders'], equipment: 'cable' },
  { slug: 'dumbbell-chest-fly', name: 'Dumbbell Chest Fly', aliases: ['db fly', 'dumbbell fly', 'db chest fly', 'dumbbell flyes', 'db chest flyes', 'flat dumbbell fly'], muscle_groups: ['chest', 'shoulders'], equipment: 'dumbbell' },

  // ---- Back / pulls & rows ----
  { slug: 'pull-up', name: 'Pull-up', aliases: ['pull up', 'pull ups', 'pull-ups', 'strict pull-up', 'bodyweight pull up'], muscle_groups: ['back', 'biceps', 'core'], equipment: 'bodyweight' },
  { slug: 'chin-up', name: 'Chin-up', aliases: ['chin up', 'chin ups', 'chin-ups', 'underhand pull up', 'bodyweight chin up'], muscle_groups: ['biceps', 'back', 'core'], equipment: 'bodyweight' },
  { slug: 'lat-pulldown', name: 'Lat Pulldown', aliases: ['lat pull down', 'pulldowns', 'cable lat pulldown', 'front pulldown', 'machine pulldown'], muscle_groups: ['back', 'biceps'], equipment: 'cable' },
  { slug: 'barbell-row', name: 'Barbell Bent-Over Row', aliases: ['bent over row', 'barbell row', 'bb row', 'bent over barbell row', 'barbell rows', 'bb rows'], muscle_groups: ['back', 'biceps', 'core'], equipment: 'barbell' },
  { slug: 'dumbbell-row', name: 'Dumbbell Row', aliases: ['db row', 'dumbel row', 'dumbbell rows', 'db rows', 'one arm dumbbell row', 'single arm db row', 'bent over db row', 'single arm dumbbell row'], muscle_groups: ['back', 'biceps'], equipment: 'dumbbell' },
  { slug: 'seated-cable-row', name: 'Seated Cable Row', aliases: ['cable row', 'seated row', 'cable rows', 'low row', 'machine row'], muscle_groups: ['back', 'biceps'], equipment: 'cable' },
  { slug: 'face-pull', name: 'Face Pull', aliases: ['face pulls', 'cable face pull', 'rope face pull', 'cable face pulls'], muscle_groups: ['shoulders', 'back'], equipment: 'cable' },
  { slug: 'barbell-shrug', name: 'Barbell Shrug', aliases: ['shrugs', 'shrug', 'bb shrug', 'barbell shrugs', 'trap shrugs'], muscle_groups: ['back', 'shoulders'], equipment: 'barbell' },

  // ---- Shoulders ----
  { slug: 'overhead-press', name: 'Overhead Press', aliases: ['ohp', 'military press', 'barbell overhead press', 'shoulder press', 'strict press', 'bb ohp'], muscle_groups: ['shoulders', 'triceps', 'core'], equipment: 'barbell' },
  { slug: 'dumbbell-shoulder-press', name: 'Dumbbell Shoulder Press', aliases: ['db shoulder press', 'dumbbell overhead press', 'db ohp', 'seated dumbbell shoulder press', 'db press shoulders'], muscle_groups: ['shoulders', 'triceps'], equipment: 'dumbbell' },
  { slug: 'arnold-press', name: 'Arnold Press', aliases: ['arnold presses', 'db arnold press', 'dumbbell arnold press'], muscle_groups: ['shoulders', 'triceps'], equipment: 'dumbbell' },
  { slug: 'lateral-raise', name: 'Dumbbell Lateral Raise', aliases: ['lateral raise', 'lateral raises', 'lat raise', 'side raises', 'db lateral raise', 'dumbbell side raise', 'db lat raises'], muscle_groups: ['shoulders'], equipment: 'dumbbell' },
  { slug: 'cable-lateral-raise', name: 'Cable Lateral Raise', aliases: ['cable lat raise', 'single arm cable lateral raise', 'side cable raise', 'cable side raise'], muscle_groups: ['shoulders'], equipment: 'cable' },
  { slug: 'machine-lateral-raise', name: 'Machine Lateral Raise', aliases: ['seated machine lateral raise', 'deltoid machine', 'lateral raise machine'], muscle_groups: ['shoulders'], equipment: 'machine' },
  { slug: 'reverse-pec-deck-fly', name: 'Reverse Pec Deck Fly', aliases: ['rear delt fly', 'reverse fly machine', 'rear delt flyes', 'machine rear delt fly', 'pec deck reverse fly'], muscle_groups: ['shoulders', 'back'], equipment: 'machine' },
  { slug: 'dumbbell-rear-delt-fly', name: 'Dumbbell Rear Delt Fly', aliases: ['db rear delt fly', 'rear delt db fly', 'bent over dumbbell reverse fly', 'dumbbell rear delt flyes'], muscle_groups: ['shoulders', 'back'], equipment: 'dumbbell' },
  { slug: 'cable-rear-delt-fly', name: 'Cable Rear Delt Fly', aliases: ['cable rear delt flyes', 'rear delt cable crossover', 'standing cable rear delt fly', 'reverse cable fly'], muscle_groups: ['shoulders', 'back'], equipment: 'cable' },
  { slug: 'incline-dumbbell-rear-delt-raise', name: 'Incline Dumbbell Rear Delt Raise', aliases: ['chest supported rear delt fly', 'incline db rear delt fly', 'incline rear delt raise', 'incline reverse db fly'], muscle_groups: ['shoulders', 'back'], equipment: 'dumbbell' },
  { slug: 'high-cable-rear-delt-row', name: 'High Cable Rear Delt Row', aliases: ['rear delt cable row', 'high cable row', 'cable rear delt row', 'face row'], muscle_groups: ['shoulders', 'back'], equipment: 'cable' },

  // ---- Biceps ----
  { slug: 'barbell-curl', name: 'Barbell Bicep Curl', aliases: ['barbell curl', 'bb curl', 'bb bicep curl', 'barbell bicep curls', 'barbell curls', 'straight bar curl', 'bicep curl', 'bicep curls', 'curls'], muscle_groups: ['biceps'], equipment: 'barbell' },
  { slug: 'dumbbell-curl', name: 'Dumbbell Bicep Curl', aliases: ['db curl', 'dumbbell curl', 'db bicep curls', 'alt db curls'], muscle_groups: ['biceps'], equipment: 'dumbbell' },
  { slug: 'hammer-curl', name: 'Hammer Curl', aliases: ['hammer curls', 'db hammer curl', 'dumbbell hammer curl', 'neutral grip curl'], muscle_groups: ['biceps'], equipment: 'dumbbell' },
  { slug: 'incline-dumbbell-curl', name: 'Incline Dumbbell Curl', aliases: ['incline db curl', 'incline curl', 'incline dumbbell curls', 'incline bicep curl'], muscle_groups: ['biceps'], equipment: 'dumbbell' },

  // ---- Triceps ----
  { slug: 'tricep-pushdown', name: 'Cable Tricep Pushdown', aliases: ['tricep pushdown', 'triceps pushdown', 'cable pushdown', 'tricep extension', 'rope pushdown', 'triceps cable pushdown'], muscle_groups: ['triceps'], equipment: 'cable' },
  { slug: 'skull-crusher', name: 'Skull Crusher', aliases: ['skullcrushers', 'skull crusher', 'lying triceps extension', 'ez bar skull crusher', 'bb skull crusher'], muscle_groups: ['triceps'], equipment: 'barbell' },
  { slug: 'overhead-dumbbell-triceps-extension', name: 'Overhead Dumbbell Triceps Extension', aliases: ['overhead tricep extension', 'db overhead tricep extension', 'dumbbell tricep extension', 'french press'], muscle_groups: ['triceps'], equipment: 'dumbbell' },

  // ---- Forearms ----
  { slug: 'barbell-wrist-curl', name: 'Barbell Wrist Curl', aliases: ['wrist curl', 'wrist curls', 'bb wrist curl', 'seated wrist curl', 'forearm wrist curl'], muscle_groups: ['forearms'], equipment: 'barbell' },
  { slug: 'dumbbell-wrist-curl', name: 'Dumbbell Wrist Curl', aliases: ['db wrist curl', 'db wrist curls', 'dumbbell forearm curl', 'seated db wrist curl'], muscle_groups: ['forearms'], equipment: 'dumbbell' },
  { slug: 'barbell-reverse-wrist-curl', name: 'Barbell Reverse Wrist Curl', aliases: ['reverse wrist curl', 'reverse wrist curls', 'bb reverse wrist curl', 'overhand wrist curl'], muscle_groups: ['forearms', 'biceps'], equipment: 'barbell' },
  { slug: 'reverse-barbell-curl', name: 'Reverse Barbell Curl', aliases: ['reverse curl', 'reverse curls', 'reverse bb curl', 'overhand barbell curl'], muscle_groups: ['forearms', 'biceps'], equipment: 'barbell' },

  // ---- Quads / squats ----
  { slug: 'squat', name: 'Barbell Squat', aliases: ['squat', 'squats', 'back squat', 'bb squat', 'barbell back squat', 'squatting'], muscle_groups: ['quads', 'glutes', 'hamstrings', 'core'], equipment: 'barbell' },
  { slug: 'front-squat', name: 'Front Squat', aliases: ['front squats', 'bb front squat', 'barbell front squat'], muscle_groups: ['quads', 'glutes', 'core'], equipment: 'barbell' },
  { slug: 'goblet-squat', name: 'Goblet Squat', aliases: ['goblet squats', 'db goblet squat', 'dumbbell goblet squat'], muscle_groups: ['quads', 'glutes', 'core'], equipment: 'dumbbell' },
  { slug: 'hack-squat', name: 'Hack Squat', aliases: ['hack squats', 'machine hack squat', 'hack squat machine'], muscle_groups: ['quads', 'glutes'], equipment: 'machine' },
  { slug: 'bulgarian-split-squat', name: 'Bulgarian Split Squat', aliases: ['split squat', 'bulgarian split squats', 'db split squat', 'rear elevated split squat', 'bss'], muscle_groups: ['quads', 'glutes', 'hamstrings'], equipment: 'dumbbell' },
  { slug: 'dumbbell-lunge', name: 'Dumbbell Lunge', aliases: ['lunge', 'lunges', 'db lunge', 'walking lunges', 'dumbbell lunges', 'db lunges', 'lunging'], muscle_groups: ['quads', 'glutes', 'hamstrings'], equipment: 'dumbbell' },
  { slug: 'barbell-forward-lunge', name: 'Barbell Forward Lunge', aliases: ['barbell lunge', 'barbell lunges', 'forward lunge', 'forward lunges', 'bb lunge', 'bb forward lunge', 'barbell walking lunge', 'barbell reverse lunge'], muscle_groups: ['quads', 'glutes', 'hamstrings'], equipment: 'barbell' },
  { slug: 'leg-press', name: 'Leg Press', aliases: ['leg presses', 'machine leg press', 'seated leg press'], muscle_groups: ['quads', 'glutes', 'hamstrings'], equipment: 'machine' },
  { slug: 'leg-extension', name: 'Leg Extension', aliases: ['leg extensions', 'machine leg extension', 'quad extensions'], muscle_groups: ['quads'], equipment: 'machine' },

  // ---- Posterior chain / hamstrings / glutes ----
  { slug: 'deadlift', name: 'Barbell Deadlift', aliases: ['deadlift', 'deadlifts', 'dl', 'bb deadlift', 'conventional deadlift', 'dead lifting'], muscle_groups: ['glutes', 'hamstrings', 'back', 'core'], equipment: 'barbell' },
  { slug: 'sumo-deadlift', name: 'Sumo Deadlift', aliases: ['sumo dl', 'barbell sumo deadlift', 'bb sumo deadlift'], muscle_groups: ['glutes', 'hamstrings', 'quads', 'back'], equipment: 'barbell' },
  { slug: 'romanian-deadlift', name: 'Romanian Deadlift', aliases: ['rdl', 'rdls', 'romanian deadlifts', 'stiff leg deadlift', 'barbell rdl', 'bb rdl'], muscle_groups: ['hamstrings', 'glutes', 'back'], equipment: 'barbell' },
  { slug: 'dumbbell-romanian-deadlift', name: 'Dumbbell Romanian Deadlift', aliases: ['db rdl', 'dumbbell rdl', 'db romanian deadlift', 'dumbbell stiff leg deadlift'], muscle_groups: ['hamstrings', 'glutes', 'back'], equipment: 'dumbbell' },
  { slug: 'barbell-hip-thrust', name: 'Barbell Hip Thrust', aliases: ['hip thrust', 'hip thrusts', 'bb hip thrust', 'glute bridge barbell', 'barbell glute bridge'], muscle_groups: ['glutes', 'hamstrings'], equipment: 'barbell' },
  { slug: 'leg-curl', name: 'Leg Curl', aliases: ['leg curls', 'hamstring curl', 'hamstring curls', 'machine leg curl', 'seated leg curl', 'lying leg curl'], muscle_groups: ['hamstrings'], equipment: 'machine' },

  // ---- Calves ----
  { slug: 'standing-calf-raise', name: 'Standing Calf Raise', aliases: ['calf raise', 'calf raises', 'standing calf raises', 'machine calf raise', 'calves raises'], muscle_groups: ['calves'], equipment: 'machine' },
  { slug: 'seated-machine-calf-raise', name: 'Seated Machine Calf Raise', aliases: ['seated calf raise', 'seated calf raises', 'machine seated calf raise', 'seated calf machine'], muscle_groups: ['calves'], equipment: 'machine' },
  { slug: 'single-leg-dumbbell-calf-raise', name: 'Single-Leg Dumbbell Calf Raise', aliases: ['single leg calf raise', 'one leg calf raise', 'db single leg calf raise', 'single leg db calf raise'], muscle_groups: ['calves'], equipment: 'dumbbell' },
  { slug: 'calf-press-on-leg-press', name: 'Calf Press on Leg Press', aliases: ['leg press calf raise', 'leg press calf press', 'calf press', 'leg press calves'], muscle_groups: ['calves'], equipment: 'machine' },
  { slug: 'donkey-calf-raise', name: 'Donkey Calf Raise', aliases: ['donkey calf raises', 'machine donkey calf raise', 'donkey calf press'], muscle_groups: ['calves'], equipment: 'machine' },

  // ---- Core ----
  { slug: 'plank', name: 'Plank', aliases: ['planks', 'front plank', 'forearm plank', 'bodyweight plank'], muscle_groups: ['core'], equipment: 'bodyweight' },
  { slug: 'crunch', name: 'Crunch', aliases: ['crunches', 'ab crunch', 'floor crunch', 'bodyweight crunch', 'basic crunch'], muscle_groups: ['core'], equipment: 'bodyweight' },
  { slug: 'side-plank', name: 'Side Plank', aliases: ['side planks', 'bodyweight side plank', 'lateral plank'], muscle_groups: ['core'], equipment: 'bodyweight' },
  { slug: 'hanging-leg-raise', name: 'Hanging Leg Raise', aliases: ['leg raise', 'hanging leg raises', 'hanging knee raise', 'captains chair leg raise'], muscle_groups: ['core'], equipment: 'bodyweight' },
  { slug: 'decline-sit-up', name: 'Decline Sit-Up', aliases: ['decline sit up', 'decline sit ups', 'decline crunch', 'weighted decline sit up'], muscle_groups: ['core'], equipment: 'bodyweight' },
  { slug: 'reverse-crunch', name: 'Reverse Crunch', aliases: ['reverse crunches', 'lying reverse crunch', 'bench reverse crunch', 'decline reverse crunch'], muscle_groups: ['core'], equipment: 'bodyweight' },
  { slug: 'cable-crunch', name: 'Cable Crunch', aliases: ['cable crunches', 'kneeling cable crunch', 'rope crunch', 'cable abdominal crunch'], muscle_groups: ['core'], equipment: 'cable' },
  { slug: 'machine-abdominal-crunch', name: 'Machine Abdominal Crunch', aliases: ['ab crunch machine', 'seated ab crunch', 'machine crunch', 'ab machine'], muscle_groups: ['core'], equipment: 'machine' },
  { slug: 'cable-woodchopper', name: 'Cable Woodchopper', aliases: ['woodchopper', 'wood chops', 'cable woodchop', 'cable rotational chop', 'woodchoppers'], muscle_groups: ['core'], equipment: 'cable' },
  { slug: 'russian-twist', name: 'Russian Twist', aliases: ['russian twists', 'weighted russian twist', 'bodyweight russian twist'], muscle_groups: ['core'], equipment: 'bodyweight' },
  { slug: 'ab-wheel-rollout', name: 'Ab Wheel Rollout', aliases: ['ab rollout', 'wheel rollout', 'ab roller', 'ab wheel'], muscle_groups: ['core'], equipment: null },
  { slug: 'dragon-flag', name: 'Dragon Flag', aliases: ['dragon flags', 'bodyweight dragon flag', 'bruce lee dragon flag'], muscle_groups: ['core'], equipment: 'bodyweight' },
];

// Upsert by slug so the script is safe to re-run (e.g. after adding new entries
// or changing the normalize logic — normalized_aliases is recomputed every run).
export async function seedExerciseCatalog(): Promise<number> {
  const connection = await createMongooseConnection();
  const ExerciseCatalog = connection.model('ExerciseCatalog');

  for (const exercise of EXERCISES) {
    await ExerciseCatalog.updateOne(
      { slug: exercise.slug },
      { $set: { ...exercise, normalized_aliases: normalizedAliasesFor(exercise.name, exercise.aliases) } },
      { upsert: true },
    );
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
