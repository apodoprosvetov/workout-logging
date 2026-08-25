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
import type { WorkerContext } from '../index.js';

// How many retry-tier round trips this message has already completed
// (research.md #4's `x-death` header, populated by RabbitMQ itself on each
// TTL-driven dead-letter hop — broker-managed, can't be forged by a client on a
// plain publish, which is exactly why this is split out as its own pure step).
export function getDeathCount(msg: ConsumeMessage): number {
  const xDeath = msg.properties.headers?.['x-death'] as unknown[] | undefined;
  return Array.isArray(xDeath) ? xDeath.length : 0;
}

// research.md #3: 3 retry attempts (5s/30s/5m) before workout.dlq + marking the
// workout failed. Routes into the next retry tier (T017's topology) rather than
// nacking — the backoff is TTL-based (a retry queue's own expiry dead-letters the
// message back onto workout.parse.q), not RabbitMQ's native immediate requeue.
// attemptNumber defaults to derived-from-the-message (real usage); the explicit
// parameter exists so the retry-tier decision is testable without needing to
// fake a broker-managed header.
export async function handleParseFailure(
  context: WorkerContext,
  msg: ConsumeMessage,
  event: WorkoutUploadedEvent,
  attemptNumber: number = getDeathCount(msg) + 1,
): Promise<void> {
  const retryQueue = retryQueueForAttempt(WORKOUT_PARSE_QUEUE, attemptNumber);

  if (retryQueue) {
    context.channel.sendToQueue(retryQueue, msg.content, { persistent: true });
  } else {
    context.channel.sendToQueue(WORKOUT_DLQ, msg.content, { persistent: true });
    try {
      await context.dataSource
        .createQueryBuilder()
        .update(Workout)
        .set({ status: WorkoutStatus.FAILED })
        .where('id = :id AND status = :pendingStatus', { id: event.workout_id, pendingStatus: WorkoutStatus.PENDING })
        .execute();
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
