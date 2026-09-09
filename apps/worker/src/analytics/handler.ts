import {
  computeWeeklyVolume,
  getRetryAttempt,
  isoWeekKey,
  retryQueueForAttempt,
  RETRY_ATTEMPT_HEADER,
  weeklyVolumeRedisKey,
  Workout,
  WorkoutParsedEvent,
  WORKOUT_ANALYTICS_QUEUE,
  WorkoutDeletedEvent,
  WORKOUT_DELETED_ROUTING_KEY,
} from '@workout-logging/shared';

import { log } from '../logger.js';

import type { WorkerContext } from '../index.js';
import type { ConsumeMessage } from 'amqplib';

// A week's cached volume is refreshed on every workout.parsed for that week, so
// it never really goes stale — this TTL only evicts weeks that see no further
// activity. The apps/api read path recomputes from Postgres on a miss anyway.
const WEEKLY_VOLUME_TTL_SECONDS = 120 * 24 * 60 * 60;

type AnalyticsEvent = WorkoutParsedEvent | WorkoutDeletedEvent;

// Discriminate on the body, never on msg.fields.routingKey. The retry tiers are
// named per primary queue and dead-letter with
// `x-dead-letter-routing-key: workout.parsed`, so a deletion that fails once
// comes back to this queue claiming to be a parse — verified against the live
// broker. Keying off the routing key would send it down the parsed branch,
// where the lookup finds nothing (the row is deleted), and the message would be
// acked without ever recomputing. Silent, permanent staleness.
function isDeletion(event: AnalyticsEvent): event is WorkoutDeletedEvent {
  return (event as WorkoutDeletedEvent).type === WORKOUT_DELETED_ROUTING_KEY;
}

export function registerAnalyticsConsumer(context: WorkerContext): void {
  void context.channel.consume(
    WORKOUT_ANALYTICS_QUEUE,
    (msg: ConsumeMessage | null) => {
      if (!msg) return;
      void handleMessage(context, msg);
    },
    { noAck: false },
  );
}

async function handleMessage(context: WorkerContext, msg: ConsumeMessage): Promise<void> {
  const event = JSON.parse(msg.content.toString()) as AnalyticsEvent;
  try {
    if (isDeletion(event)) {
      // The week comes from the payload — the workout row no longer exists.
      await recomputeWeek(context, event.user_id, new Date(event.performed_at));
    } else {
      const workout = await context.dataSource.getRepository(Workout).findOne({
        where: { id: event.workout_id },
        select: { id: true, userId: true, performedAt: true },
      });
      // if workout is missing it was deleted between parse and now — nothing to
      // recompute, but still ack below so the message isn't redelivered forever
      if (workout) {
        await recomputeWeek(context, workout.userId, workout.performedAt);
      }
    }

    context.channel.ack(msg);
  } catch (err) {
    log.error('analytics recompute failed', {
      workout_id: event.workout_id,
      event_id: event.event_id,
      err,
    });
    await handleAnalyticsFailure(context, msg, event);
  }
}

// FR-016: fully recompute the ISO week the workout belongs to and overwrite its
// Redis hash. A full recompute (not an incremental HINCRBY) is idempotent across
// redeliveries and self-corrects after a workout is deleted or re-parsed.
async function recomputeWeek(
  context: WorkerContext,
  userId: string,
  performedAt: Date,
): Promise<void> {
  const volume = await computeWeeklyVolume(
    context.dataSource,
    context.mongoConnection,
    userId,
    performedAt,
  );
  const key = weeklyVolumeRedisKey(userId, isoWeekKey(performedAt));

  const pipeline = context.redis.multi().del(key);
  if (Object.keys(volume).length > 0) {
    pipeline.hset(
      key,
      Object.fromEntries(Object.entries(volume).map(([group, v]) => [group, String(v)])),
    );
    pipeline.expire(key, WEEKLY_VOLUME_TTL_SECONDS);
  }
  await pipeline.exec();
}

// Analytics failures are transient (a Redis/Postgres blip). Walk the same retry
// tiers as the parser (research.md #3). Once exhausted, just drop it — there's
// no workout state to mark failed, and apps/api's Postgres fallback rebuilds the
// cache on the next dashboard read.
async function handleAnalyticsFailure(
  context: WorkerContext,
  msg: ConsumeMessage,
  event: AnalyticsEvent,
): Promise<void> {
  const attempt = getRetryAttempt(msg) + 1;
  const retryQueue = retryQueueForAttempt(WORKOUT_ANALYTICS_QUEUE, attempt);
  if (retryQueue) {
    log.warn('analytics queued for retry', {
      workout_id: event.workout_id,
      event_id: event.event_id,
      attempt,
      retry_queue: retryQueue,
    });
    context.channel.sendToQueue(retryQueue, msg.content, {
      persistent: true,
      headers: { [RETRY_ATTEMPT_HEADER]: attempt },
    });
  } else {
    // Dropped, not dead-lettered: apps/api's Postgres fallback rebuilds the
    // cache on the next dashboard read, so there's nothing to recover.
    log.error('analytics exhausted retries — dropped', {
      workout_id: event.workout_id,
      event_id: event.event_id,
      attempts: attempt - 1,
    });
  }
  context.channel.ack(msg);
}
