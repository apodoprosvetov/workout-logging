import {
  deleteWorkoutImages,
  getWorkoutImagesBucket,
  RawUploadDocument,
  retryQueueForAttempt,
  Workout,
  WorkoutStatus,
  WorkoutUploadedEvent,
  WORKOUT_DLQ,
  WORKOUT_PARSE_QUEUE,
} from '@workout-logging/shared';
import type { ConsumeMessage } from 'amqplib';
import type { DataSource } from 'typeorm';
import type { WorkerContext } from '../index.js';

// Thrown by processWorkout for a failure that retrying can never fix (a
// raw_uploads doc or workout row that isn't there). handleMessage marks the
// workout failed and acks instead of feeding it through the retry tiers —
// 5s/30s/5m of re-attempts + a DLQ hop for something that will never succeed
// is pure log noise.
export class NonRetryableParseError extends Error {}

const RETRY_ATTEMPT_HEADER = 'x-retry-attempt';

// How many retry cycles this message has already been through, read from a
// header the worker sets itself.
//
// research.md #4 originally leaned on RabbitMQ's `x-death` header for this, but
// that only works for the *first* hop: handleParseFailure re-publishes the
// message to the next tier with `sendToQueue`, and RabbitMQ strips the reserved
// `x-death` on any client publish — so on the next dead-letter the count resets
// and the message loops in one tier forever, never reaching the DLQ. A plain
// custom header survives both the client publish and the TTL dead-letter hop,
// so the worker owns the counter explicitly. The exchange is internal (only
// apps/api publishes `workout.uploaded`), so "a client could forge it" isn't a
// real concern here.
export function getRetryAttempt(msg: ConsumeMessage): number {
  const raw = msg.properties.headers?.[RETRY_ATTEMPT_HEADER];
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

// Guarded transition, mirrored from handler.ts: only a still-pending workout
// moves to failed, so a redelivered duplicate can't stomp a terminal status.
export async function markWorkoutFailed(dataSource: DataSource, workoutId: string): Promise<void> {
  await dataSource
    .createQueryBuilder()
    .update(Workout)
    .set({ status: WorkoutStatus.FAILED })
    .where('id = :id AND status = :pendingStatus', { id: workoutId, pendingStatus: WorkoutStatus.PENDING })
    .execute();
}

// research.md #3: 3 retry attempts (5s/30s/5m) before workout.dlq + marking the
// workout failed. Routes into the next retry tier (T017's topology) rather than
// nacking — the backoff is TTL-based (a retry queue's own expiry dead-letters the
// message back onto workout.parse.q), not RabbitMQ's native immediate requeue.
// attemptNumber defaults to derived-from-the-message (real usage); the explicit
// parameter exists so the retry-tier decision is testable without a broker hop.
export async function handleParseFailure(
  context: WorkerContext,
  msg: ConsumeMessage,
  event: WorkoutUploadedEvent,
  attemptNumber: number = getRetryAttempt(msg) + 1,
): Promise<void> {
  const retryQueue = retryQueueForAttempt(WORKOUT_PARSE_QUEUE, attemptNumber);

  if (retryQueue) {
    // Carry the attempt counter forward — it survives the TTL dead-letter hop
    // back to workout.parse.q, so the next failure lands one tier deeper.
    context.channel.sendToQueue(retryQueue, msg.content, {
      persistent: true,
      headers: { [RETRY_ATTEMPT_HEADER]: attemptNumber },
    });
  } else {
    context.channel.sendToQueue(WORKOUT_DLQ, msg.content, { persistent: true });
    try {
      await markWorkoutFailed(context.dataSource, event.workout_id);
    } catch (err) {
      // Best-effort per contracts/events.md — the DLQ message is still the
      // source of truth for manual recovery even if this write fails too.
      console.error(`failed to mark workout ${event.workout_id} as failed`, err);
    }

    // Exhausted: no further retries will read raw_uploads again — images are
    // transient (research.md #11), so clean them up now. Manual DLQ recovery
    // after this point needs the user to resubmit the photo(s).
    try {
      const rawUpload = await context.mongoConnection
        .model<RawUploadDocument>('RawUpload')
        .findById(event.raw_upload_ref);
      if (rawUpload && rawUpload.image_refs.length > 0) {
        await deleteWorkoutImages(getWorkoutImagesBucket(context.mongoConnection), rawUpload.image_refs);
      }
    } catch (err) {
      console.error(`failed to delete workout_images for raw_upload ${event.raw_upload_ref}`, err);
    }
  }

  context.channel.ack(msg);
}
