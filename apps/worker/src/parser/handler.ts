import { randomUUID } from 'node:crypto';
import {
  deleteWorkoutImages,
  getWorkoutImagesBucket,
  RawUploadDocument,
  SetUnit,
  withEventIdempotency,
  Workout,
  WorkoutExercise,
  WorkoutParsedEvent,
  WorkoutSet,
  WorkoutStatus,
  WorkoutUploadedEvent,
  WORKOUT_EVENTS_EXCHANGE,
  WORKOUT_PARSE_QUEUE,
  WORKOUT_PARSED_ROUTING_KEY,
} from '@workout-logging/shared';
import type { ConsumeMessage } from 'amqplib';
import type { EntityManager } from 'typeorm';
import type { WorkerContext } from '../index.js';
import { extractWorkoutFromText } from './claude.js';
import { matchAndUpsertExercise } from './exercise-matcher.js';
import { handleParseFailure } from './retry.js';

export function registerParserConsumer(context: WorkerContext): void {
  void context.channel.consume(
    WORKOUT_PARSE_QUEUE,
    (msg: ConsumeMessage | null) => {
      if (!msg) return;
      void handleMessage(context, msg);
    },
    { noAck: false },
  );
}

async function handleMessage(context: WorkerContext, msg: ConsumeMessage): Promise<void> {
  const event = JSON.parse(msg.content.toString()) as WorkoutUploadedEvent;
  try {
    await withEventIdempotency(context.dataSource, event.event_id, (manager) =>
      processWorkout(context, manager, event),
    );
    context.channel.ack(msg);
  } catch (err) {
    console.error(`parse failed for workout ${event.workout_id}`, err);
    await handleParseFailure(context, msg, event);
  }
}

async function processWorkout(context: WorkerContext, manager: EntityManager, event: WorkoutUploadedEvent): Promise<void> {
  const rawUploadModel = context.mongoConnection.model<RawUploadDocument>('RawUpload');
  const rawUpload = await rawUploadModel.findById(event.raw_upload_ref);
  if (!rawUpload) {
    throw new Error(`raw_uploads/${event.raw_upload_ref} not found`);
  }

  const workoutRow = await manager.getRepository(Workout).findOneBy({ id: event.workout_id });
  if (!workoutRow) {
    throw new Error(`workout ${event.workout_id} not found`);
  }

  // Text-only this phase — T044 adds the image/vision branch (research.md #8:
  // a single combined Claude request when both text and image are present).
  const extracted = rawUpload.text
    ? await extractWorkoutFromText(rawUpload.text)
    : { name: null, performedAt: null, exercises: [] };

  const workoutExerciseRepository = manager.getRepository(WorkoutExercise);
  const setRepository = manager.getRepository(WorkoutSet);

  let allMatched = true;
  let exerciseOrder = 0;
  for (const item of extracted.exercises) {
    exerciseOrder += 1;
    const { exercise, matched } = await matchAndUpsertExercise(manager, context.mongoConnection, item.name);
    if (!matched) allMatched = false;

    const workoutExercise = await workoutExerciseRepository.save(
      workoutExerciseRepository.create({
        workoutId: event.workout_id,
        exerciseId: exercise.id,
        exerciseOrder,
      }),
    );

    let setOrder = 0;
    for (const set of item.sets) {
      setOrder += 1;
      await setRepository.save(
        setRepository.create({
          workoutExerciseId: workoutExercise.id,
          setOrder,
          weight: String(set.weight),
          reps: set.reps,
          unit: set.unit === 'lb' ? SetUnit.LB : SetUnit.KG,
        }),
      );
    }
  }

  // needs_review: zero exercises extracted (ambiguous/garbage input), or at
  // least one exercise didn't match the catalog (research.md #7 — muscle-group
  // attribution is incomplete, but the workout itself is not blocked/discarded).
  const status =
    extracted.exercises.length === 0 || !allMatched ? WorkoutStatus.NEEDS_REVIEW : WorkoutStatus.PARSED;

  // name: extracted from the text as literally written (e.g. "Низ А"), never
  // invented from the exercise list — still deferred beyond MVP (spec.md
  // Assumptions). performedAt: only overwritten when the caller didn't
  // explicitly supply one at ingestion — an explicit value always wins.
  const updates: Partial<Workout> = { status };
  if (extracted.name) updates.name = extracted.name;
  if (extracted.performedAt && !workoutRow.performedAtExplicit) {
    updates.performedAt = new Date(`${extracted.performedAt}T00:00:00.000Z`);
  }

  // Guarded transition (research.md #4's second line of defense): a redelivered
  // duplicate that somehow got past withEventIdempotency still can't double-write.
  await manager
    .createQueryBuilder()
    .update(Workout)
    .set(updates)
    .where('id = :id AND status = :pendingStatus', { id: event.workout_id, pendingStatus: WorkoutStatus.PENDING })
    .execute();

  const parsedEvent: WorkoutParsedEvent = {
    event_id: randomUUID(),
    user_id: event.user_id,
    workout_id: event.workout_id,
    exercise_count: extracted.exercises.length,
    occurred_at: new Date().toISOString(),
  };
  context.channel.publish(
    WORKOUT_EVENTS_EXCHANGE,
    WORKOUT_PARSED_ROUTING_KEY,
    Buffer.from(JSON.stringify(parsedEvent)),
    { persistent: true },
  );

  // Images are transient (research.md #11) — this is a terminal status
  // (parsed/needs_review), so nothing will read raw_uploads' images again.
  // Best-effort: a cleanup failure shouldn't fail/retry an already-succeeded parse.
  if (rawUpload.image_refs.length > 0) {
    try {
      await deleteWorkoutImages(getWorkoutImagesBucket(context.mongoConnection), rawUpload.image_refs);
    } catch (err) {
      console.error(`failed to delete workout_images for raw_upload ${rawUpload._id.toString()}`, err);
    }
  }
}
