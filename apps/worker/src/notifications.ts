import { ChangeNotification, getEventsChannelName } from '@workout-logging/shared';

import { log } from './logger.js';

import type { Redis } from 'ioredis';

/**
 * Send one notification to its owner's channel, best-effort.
 *
 * Never throws and never rejects: delivery failing must not fail the work that
 * produced the change (FR-030). A workout that was parsed stays parsed even if
 * nobody could be told.
 *
 * The `await` is load-bearing, not style. `redis.publish` returns a promise, so
 * without it the catch below cannot see a rejection — it escapes as an
 * unhandled rejection instead, and the swallowing fails in exactly the case it
 * exists for. Verified by forcing a publish to reject.
 */
export async function publishNotification(
  redis: Redis,
  notification: ChangeNotification,
): Promise<void> {
  try {
    await redis.publish(getEventsChannelName(notification.user_id), JSON.stringify(notification));
  } catch (err) {
    log.error('failed to publish notification', {
      user: notification.user_id,
      type: notification.type,
      err: err,
    });
  }
}
