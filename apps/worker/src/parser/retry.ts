import { randomUUID } from 'node:crypto';

import {
  deleteWorkoutImages,
  getRetryAttempt,
  getWorkoutImagesBucket,
  RawUploadDocument,
  RETRY_ATTEMPT_HEADER,
  retryQueueForAttempt,
  WorkoutStatus,
  WorkoutUploadedEvent,
  WORKOUT_DLQ,
  WORKOUT_PARSE_QUEUE,
  WORKOUT_SETTLED_KEY,
  workoutsRepository,
} from '@workout-logging/shared';

import { log } from '../logger.js';
import { publishNotification } from '../notifications.js';

import type { WorkerContext } from '../index.js';
import type { ConsumeMessage } from 'amqplib';

export { getRetryAttempt };

// Thrown by processWorkout for a failure that retrying can never fix (a
// raw_uploads doc or workout row that isn't there). handleMessage marks the
// workout failed and acks instead of feeding it through the retry tiers —
// 5s/30s/5m of re-attempts + a DLQ hop for something that will never succeed
// is pure log noise.
export class NonRetryableParseError extends Error {}

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
    log.warn('parse queued for retry', {
      workout_id: event.workout_id,
      event_id: event.event_id,
      attempt: attemptNumber,
      retry_queue: retryQueue,
    });
    context.channel.sendToQueue(retryQueue, msg.content, {
      persistent: true,
      headers: { [RETRY_ATTEMPT_HEADER]: attemptNumber },
    });
  } else {
    log.error('parse exhausted retries — dead-lettered and marked failed', {
      workout_id: event.workout_id,
      event_id: event.event_id,
      attempt: attemptNumber,
    });
    context.channel.sendToQueue(WORKOUT_DLQ, msg.content, { persistent: true });
    try {
      const settled = await workoutsRepository(context.dataSource).markFailed(event.workout_id);

      // null means the guard skipped the update — the workout had already left
      // `pending`, so it has been announced once and must not be announced again.
      if (settled) {
        await publishNotification(context.redis, {
          type: WORKOUT_SETTLED_KEY,
          event_id: randomUUID(),
          user_id: settled.userId,
          occurred_at: new Date().toISOString(),
          workout_id: event.workout_id,
          status: WorkoutStatus.FAILED,
          performed_at: settled.performedAt.toISOString(),
        });
      }
    } catch (err) {
      // Best-effort per contracts/events.md — the DLQ message is still the
      // source of truth for manual recovery even if this write fails too.
      log.error('failed to mark workout failed', { workout_id: event.workout_id, err });
    }

    // Exhausted: no further retries will read raw_uploads again — images are
    // transient (research.md #11), so clean them up now. Manual DLQ recovery
    // after this point needs the user to resubmit the photo(s).
    try {
      const rawUpload = await context.mongoConnection
        .model<RawUploadDocument>('RawUpload')
        .findById(event.raw_upload_ref);
      if (rawUpload && rawUpload.image_refs.length > 0) {
        await deleteWorkoutImages(
          getWorkoutImagesBucket(context.mongoConnection),
          rawUpload.image_refs,
        );
      }
    } catch (err) {
      log.error('failed to delete workout_images after DLQ', {
        workout_id: event.workout_id,
        raw_upload_ref: event.raw_upload_ref,
        err,
      });
    }
  }

  context.channel.ack(msg);
}
