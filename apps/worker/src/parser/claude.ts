import Anthropic from '@anthropic-ai/sdk';

// DeepSeek's Anthropic-compatible endpoint (user decision — see the DeepSeek key
// swap during T031). @anthropic-ai/sdk works unmodified against it via baseURL.
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: 'https://api.deepseek.com/anthropic',
});
const MODEL = 'deepseek-v4-pro';
const MAX_TOKENS = 1024;

const RECORD_WORKOUT_TOOL: Anthropic.Tool = {
  name: 'record_workout',
  description: 'Record the exercises and sets extracted from a workout description',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'The workout/day label as literally written by the user, e.g. "Низ А" or "Push day". ' +
          'Omit this field entirely if no such label appears in the text — never invent one from the exercises.',
      },
      performed_at: {
        type: 'string',
        description:
          'The date the workout was performed, as an ISO 8601 date (YYYY-MM-DD), only if a date ' +
          'literally appears in the text (e.g. "09.08.2026" -> "2026-08-09"). Omit if no date is present.',
      },
      exercises: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Canonical exercise name, e.g. "Bench Press"' },
            sets: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  weight: {
                    type: 'number',
                    description:
                      'Weight lifted, in the given unit. Use 0 for bodyweight-only sets where no ' +
                      'external weight is mentioned (e.g. "8 повторень" with no weight given) — never omit ' +
                      'the set or invent a non-zero weight.',
                  },
                  reps: { type: 'integer' },
                  unit: { type: 'string', enum: ['kg', 'lb'] },
                },
                required: ['weight', 'reps', 'unit'],
              },
            },
          },
          required: ['name', 'sets'],
        },
      },
    },
    required: ['exercises'],
  },
};

export interface ExtractedSet {
  weight: number;
  reps: number;
  unit: 'kg' | 'lb';
}

export interface ExtractedExercise {
  name: string;
  sets: ExtractedSet[];
}

export interface ExtractedWorkout {
  name: string | null;
  performedAt: string | null;
  exercises: ExtractedExercise[];
}

// research.md #7: Claude (via the tool schema) returns its best-guess canonical
// exercise name per recognized movement; the worker matches that against
// exercise_catalog.aliases (exercise-matcher.ts), not the other way around.
//
// tool_choice is 'auto', not a forced tool call: this model runs extended
// thinking by default, which doesn't support forcing a specific tool — so an
// empty/no-tool-call response is a real, expected outcome (garbage input),
// not an error, and maps to zero exercises extracted.
export async function extractWorkoutFromText(text: string): Promise<ExtractedWorkout> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    tools: [RECORD_WORKOUT_TOOL],
    tool_choice: { type: 'auto' },
    messages: [
      {
        role: 'user',
        content: `Extract the exercises, sets, reps, and weight from this workout log using the record_workout tool. Default to kg if no unit is given. For bodyweight-only sets with no weight mentioned, use weight 0 — do not skip the set or make up a weight. Also extract the workout name/label and date if they literally appear in the text (do not guess or invent them).\n\n${text}`,
      },
    ],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );
  if (!toolUse) {
    return { name: null, performedAt: null, exercises: [] };
  }

  const input = toolUse.input as {
    name?: unknown;
    performed_at?: unknown;
    exercises?: unknown[];
  };

  // `exercises` is a required schema field — the model sometimes calls the
  // tool (stop_reason: 'tool_use') but serializes empty/malformed arguments
  // despite reasoning through the extraction correctly in its thinking block
  // (verified reproducible against DeepSeek, ~1/3 of calls in a small sample).
  // That's a transient call-level glitch, not "ambiguous input" (which is the
  // !toolUse branch above) — throw so it goes through the T032 retry/DLQ path
  // instead of being silently recorded as zero exercises / needs_review.
  if (!Array.isArray(input.exercises)) {
    throw new Error('record_workout tool call returned malformed input (missing exercises array)');
  }
  const exercises = input.exercises;

  return {
    name: typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim() : null,
    performedAt: isValidIsoDate(input.performed_at) ? (input.performed_at as string) : null,
    exercises: (exercises as ExtractedExercise[])
      .filter((e): e is ExtractedExercise => typeof e?.name === 'string' && Array.isArray(e.sets))
      .map((e) => ({
        name: e.name,
        sets: e.sets
          .filter((s) => typeof s?.weight === 'number' && typeof s?.reps === 'number')
          .map((s) => ({ weight: s.weight, reps: s.reps, unit: s.unit === 'lb' ? 'lb' : 'kg' })),
      })),
  };
}

// Guards against a malformed/hallucinated date string reaching `new Date()`
// downstream — a full YYYY-MM-DD parse, not just "did Date() not choke on it"
// (Date is lenient about all sorts of non-ISO garbage).
function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime());
}
