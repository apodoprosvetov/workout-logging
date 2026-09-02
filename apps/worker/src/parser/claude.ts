import Anthropic from '@anthropic-ai/sdk';

// DeepSeek's Anthropic-compatible endpoint (user decision — see the DeepSeek key
// swap during T031). @anthropic-ai/sdk works unmodified against it via baseURL.
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: 'https://api.deepseek.com/anthropic',
});
// research.md #14: deepseek-v4-pro is text-only. The image/vision branch has to
// use deepseek-v4-flash-vision-exp (the only DeepSeek model with vision), so the
// model is chosen per-request by whether any images are present.
const MODEL_TEXT = 'deepseek-v4-pro';
const MODEL_VISION = 'deepseek-v4-flash-vision-exp';

// Output budget grows with input: 1024 is plenty for a text log, but a
// multi-image submission (up to MAX_WORKOUT_IMAGES) needs more headroom.
const MAX_TOKENS_TEXT = 1024;
const MAX_TOKENS_FEW_IMAGES = 2048;
const MAX_TOKENS_MANY_IMAGES = 4096;
const MANY_IMAGES_THRESHOLD = 5;

type ContentBlockParam = Anthropic.TextBlockParam | Anthropic.ImageBlockParam;
type ImageMediaType = Anthropic.ImageBlockParam.Source['media_type'];

export interface WorkoutImage {
  data: string;
  mediaType: ImageMediaType;
}

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
  rawResponse: string;
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
export async function extractWorkout({
  text,
  images,
}: {
  text: string | null;
  images: WorkoutImage[] | null;
}): Promise<ExtractedWorkout> {
  const imageBlocks = images ?? [];
  const logText = text?.trim() ?? '';

  if (!logText && imageBlocks.length === 0) {
    throw new Error('extractWorkout called with neither text nor images');
  }

  const hasImages = imageBlocks.length > 0;
  const model = hasImages ? MODEL_VISION : MODEL_TEXT;
  const maxTokens = !hasImages
    ? MAX_TOKENS_TEXT
    : imageBlocks.length > MANY_IMAGES_THRESHOLD
      ? MAX_TOKENS_MANY_IMAGES
      : MAX_TOKENS_FEW_IMAGES;

  const content: ContentBlockParam[] = [
    ...imageBlocks.map((image): Anthropic.ImageBlockParam => ({
      type: 'image',
      source: { type: 'base64', data: image.data, media_type: image.mediaType },
    })),
    {
      type: 'text',
      text:
        'Extract the exercises, sets, reps, and weight from this workout log using the record_workout tool. ' +
        'The log may be free text, one or more photos/screenshots, or both — read all of them as one workout. ' +
        'Default to kg if no unit is given. For bodyweight-only sets with no weight mentioned, use weight 0 — ' +
        'do not skip the set or make up a weight. Also extract the workout name/label and date if they literally ' +
        `appear (do not guess or invent them).${logText ? `\n\n${logText}` : ''}`,
    },
  ];

  const stream = client.messages.stream({
    model,
    max_tokens: maxTokens,
    tools: [RECORD_WORKOUT_TOOL],
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content }],
  });

  const response = await stream.finalMessage();

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );
  if (!toolUse) {
    return {
      rawResponse: JSON.stringify(response, null, 2),
      name: null,
      performedAt: null,
      exercises: [],
    };
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
    rawResponse: JSON.stringify(response, null, 2),
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
