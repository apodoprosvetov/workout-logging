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
  downloadWorkoutImage,
} from '@workout-logging/shared';

import { extractWorkout } from './claude.js';
import { matchAndUpsertExercise } from './exercise-matcher.js';
import { detectImageMediaType, ImageMediaType } from './image-media-type.js';
import { handleParseFailure, markWorkoutFailed, NonRetryableParseError } from './retry.js';
import { log } from '../logger.js';

import type { WorkerContext } from '../index.js';
import type { ConsumeMessage } from 'amqplib';
import type { EntityManager } from 'typeorm';

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
    const outcome = await withEventIdempotency(context.dataSource, event.event_id, (manager) =>
      processWorkout(context, manager, event),
    );
    // Publish workout.parsed only after the transaction has committed — an event
    // about a state that could still roll back would race the analytics worker
    // (T047) into recomputing a week that doesn't include this workout yet.
    if (!outcome.alreadyProcessed) {
      context.channel.publish(
        WORKOUT_EVENTS_EXCHANGE,
        WORKOUT_PARSED_ROUTING_KEY,
        Buffer.from(JSON.stringify(outcome.result)),
        { persistent: true },
      );
      log.info('workout parsed', {
        workout_id: event.workout_id,
        event_id: event.event_id,
        exercise_count: outcome.result.exercise_count,
      });
    } else {
      log.info('workout.uploaded redelivered, already processed', {
        workout_id: event.workout_id,
        event_id: event.event_id,
      });
    }
    context.channel.ack(msg);
  } catch (err) {
    if (err instanceof NonRetryableParseError) {
      // Nothing to parse and retrying won't change that — mark failed and drop
      // it rather than looping it through the retry tiers.
      log.warn('parse abandoned (non-retryable)', {
        workout_id: event.workout_id,
        event_id: event.event_id,
        reason: err.message,
      });
      try {
        await markWorkoutFailed(context.dataSource, event.workout_id);
      } catch (markErr) {
        log.error('failed to mark workout failed', { workout_id: event.workout_id, err: markErr });
      }
      context.channel.ack(msg);
      return;
    }
    log.error('parse failed', { workout_id: event.workout_id, event_id: event.event_id, err });
    await handleParseFailure(context, msg, event);
  }
}

async function processWorkout(
  context: WorkerContext,
  manager: EntityManager,
  event: WorkoutUploadedEvent,
): Promise<WorkoutParsedEvent> {
  const rawUploadModel = context.mongoConnection.model<RawUploadDocument>('RawUpload');
  const rawUpload = await rawUploadModel.findById(event.raw_upload_ref);
  if (!rawUpload) {
    // Never transient: ingestion.service.ts commits the raw_uploads doc before
    // it publishes workout.uploaded, so "not found" means it was deleted (or
    // this is a stale event from a wiped test run) — not "not written yet".
    throw new NonRetryableParseError(`raw_uploads/${event.raw_upload_ref} not found`);
  }

  const workoutRow = await manager.getRepository(Workout).findOneBy({ id: event.workout_id });
  if (!workoutRow) {
    throw new NonRetryableParseError(`workout ${event.workout_id} not found`);
  }

  // T044: fetch every image the submission carried (research.md #11 — they're
  // still in GridFS, cleanup only happens after a terminal status below) and
  // sniff each one's media type from its bytes. An unreadable image throws,
  // failing the parse into the T032 retry/DLQ path rather than quietly sending
  // the model fewer images than the user submitted.
  const imageBucket = getWorkoutImagesBucket(context.mongoConnection);
  const imageBuffers = await Promise.all(
    rawUpload.image_refs.map((ref) => downloadWorkoutImage(imageBucket, ref)),
  );
  const images = imageBuffers.map((buffer) => {
    const mediaType: ImageMediaType | null = detectImageMediaType(buffer);
    if (!mediaType) throw new Error('workout image has an unrecognised format');
    return { data: buffer.toString('base64'), mediaType };
  });

  // research.md #8: one combined extraction call for whichever of text / images
  // is present (research.md #14 — images route to the vision model).
  const extracted = await extractWorkout({ text: rawUpload.text, images });

  const workoutExerciseRepository = manager.getRepository(WorkoutExercise);
  const setRepository = manager.getRepository(WorkoutSet);

  rawUpload.ai_response_raw = extracted.rawResponse;
  await rawUpload.save();

  let allMatched = true;
  let exerciseOrder = 0;
  for (const item of extracted.exercises) {
    exerciseOrder += 1;
    const { exercise, matched } = await matchAndUpsertExercise(
      manager,
      context.mongoConnection,
      item.name,
    );
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
    extracted.exercises.length === 0 || !allMatched
      ? WorkoutStatus.NEEDS_REVIEW
      : WorkoutStatus.PARSED;

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
    .where('id = :id AND status = :pendingStatus', {
      id: event.workout_id,
      pendingStatus: WorkoutStatus.PENDING,
    })
    .execute();

  const parsedEvent: WorkoutParsedEvent = {
    event_id: randomUUID(),
    user_id: event.user_id,
    workout_id: event.workout_id,
    exercise_count: extracted.exercises.length,
    occurred_at: new Date().toISOString(),
  };

  // Images are transient (research.md #11) — this is a terminal status
  // (parsed/needs_review), so nothing will read raw_uploads' images again.
  // Best-effort: a cleanup failure shouldn't fail/retry an already-succeeded parse.
  if (rawUpload.image_refs.length > 0) {
    try {
      await deleteWorkoutImages(
        getWorkoutImagesBucket(context.mongoConnection),
        rawUpload.image_refs,
      );
    } catch (err) {
      log.error('failed to delete workout_images after terminal status', {
        workout_id: event.workout_id,
        raw_upload_ref: rawUpload._id.toString(),
        err,
      });
    }
  }

  return parsedEvent;
}
