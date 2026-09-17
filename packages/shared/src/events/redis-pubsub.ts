import Redis from 'ioredis';

import { ChangeNotification, getEventsChannelName } from './notifications';
import { redisUrl } from '../db/redis';
import { AppLogger } from '../log';

// Redis as transport, not datastore — hence events/ rather than db/redis.ts,
// which is the weekly-volume cache (docs/specs-archive/004 research #2).
//
// Kept out of notifications.ts so that module stays types plus a pure function:
// importing ioredis there would make the types unusable in apps/web.

/**
 * A connection dedicated to subscribing, not interchangeable with
 * `createRedisClient()` in either direction: after `subscribe()`, ioredis
 * rejects every command but subscribe/unsubscribe/ping/quit, so the cache
 * client cannot be reused here and this one cannot serve the cache.
 *
 * Subscribing, routing and closing belong to the caller.
 */
export function createRedisSubscriber(): Redis {
  return new Redis(redisUrl);
}

/**
 * Send one notification to its owner's channel, best-effort.
 *
 * Shared by both apps so the channel name and encoding cannot drift — one line
 * of difference is a notification nobody receives, with no error to say so.
 *
 * **Never throws.** Failed delivery must not fail the work that produced the
 * change (FR-030), guaranteed here rather than asked of every caller. The
 * `await` is load-bearing: without it a rejection escapes the catch as an
 * unhandled rejection, failing in exactly the case this exists for.
 *
 * The logger is required — swallowing silently would make a dead channel look
 * like a quiet one.
 */
export async function publishNotification(
  redis: Redis,
  notification: ChangeNotification,
  log: AppLogger,
): Promise<void> {
  try {
    await redis.publish(getEventsChannelName(notification.user_id), JSON.stringify(notification));
  } catch (err) {
    log.error('failed to publish notification', {
      user: notification.user_id,
      type: notification.type,
      event_id: notification.event_id,
      err,
    });
  }
}
