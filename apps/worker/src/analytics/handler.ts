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
} from '@workout-logging/shared';
import type { ConsumeMessage } from 'amqplib';
import type { WorkerContext } from '../index.js';

// A week's cached volume is refreshed on every workout.parsed for that week, so
// it never really goes stale — this TTL only evicts weeks that see no further
// activity. The apps/api read path recomputes from Postgres on a miss anyway.
const WEEKLY_VOLUME_TTL_SECONDS = 120 * 24 * 60 * 60;

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
  const event = JSON.parse(msg.content.toString()) as WorkoutParsedEvent;
  try {
    await recomputeWeek(context, event);
    context.channel.ack(msg);
  } catch (err) {
    console.error(`analytics failed for workout ${event.workout_id}`, err);
    await handleAnalyticsFailure(context, msg, event);
  }
}

// FR-016: fully recompute the ISO week the workout belongs to and overwrite its
// Redis hash. A full recompute (not an incremental HINCRBY) is idempotent across
// redeliveries and self-corrects after a workout is deleted or re-parsed.
async function recomputeWeek(context: WorkerContext, event: WorkoutParsedEvent): Promise<void> {
  const workout = await context.dataSource.getRepository(Workout).findOne({
    where: { id: event.workout_id },
    select: { id: true, userId: true, performedAt: true },
  });
  if (!workout) return; // deleted between parse and now — nothing to do

  const volume = await computeWeeklyVolume(
    context.dataSource,
    context.mongoConnection,
    workout.userId,
    workout.performedAt,
  );
  const key = weeklyVolumeRedisKey(workout.userId, isoWeekKey(workout.performedAt));

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
  event: WorkoutParsedEvent,
): Promise<void> {
  const attempt = getRetryAttempt(msg) + 1;
  const retryQueue = retryQueueForAttempt(WORKOUT_ANALYTICS_QUEUE, attempt);
  if (retryQueue) {
    context.channel.sendToQueue(retryQueue, msg.content, {
      persistent: true,
      headers: { [RETRY_ATTEMPT_HEADER]: attempt },
    });
  } else {
    console.error(`analytics gave up on workout ${event.workout_id} after ${attempt - 1} retries`);
  }
  context.channel.ack(msg);
}
