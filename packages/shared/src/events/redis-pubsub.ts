import Redis from 'ioredis';

import { ChangeNotification, getEventsChannelName } from './notifications';
import { redisUrl } from '../db/redis';
import { AppLogger } from '../log';

// Redis as a *transport*, not as a datastore — which is why this sits in
// events/ next to rabbitmq.ts rather than in db/redis.ts. The two share a
// protocol and a URL and nothing else: db/redis.ts is the weekly-volume cache,
// this is the notification fan-out (specs/004 research #2).
//
// Deliberately not folded into notifications.ts, even though the channel-name
// helper lives there: that module is types plus one pure function, with no
// runtime dependency. Importing ioredis into it would make the notification
// types unusable anywhere that cannot take a Redis client — apps/web being the
// case that matters, once it needs them.

/**
 * A connection dedicated to subscribing.
 *
 * Separate from `createRedisClient()` on purpose, and not interchangeable with
 * it in either direction: once `subscribe()` is called, ioredis puts the
 * connection into subscriber mode and rejects every command that is not a
 * subscribe/unsubscribe/ping/quit. So the caller cannot reuse a client that
 * also serves the weekly-volume cache — the `GET`/`HSET` calls would start
 * failing — and cannot run ordinary commands on this one.
 *
 * The URL is imported rather than re-resolved so `REDIS_URL` keeps one
 * definition; a second dotenv block here would drift from db/redis.ts the first
 * time either changed.
 *
 * Returns a raw connection: subscribing and routing belong to the caller, and
 * so does closing it.
 */
export function createRedisSubscriber(): Redis {
  return new Redis(redisUrl);
}

/**
 * Send one notification to its owner's channel, best-effort.
 *
 * The other half of `createRedisSubscriber`, and here for the same reason: both
 * apps publish — `apps/api` when a workout is created or deleted, `apps/worker`
 * when one settles, fails, or a week's volume is recomputed — and they must
 * agree on the channel and the encoding exactly. One line of drift between them
 * is a notification nobody receives, with no error anywhere to say so.
 *
 * Takes a client rather than making one: publishing is an ordinary command, so
 * it runs on whatever connection the caller already has. Only *subscribing*
 * needs a dedicated connection — see above.
 *
 * **Never throws and never rejects.** Delivery failing must not fail the work
 * that produced the change (FR-030): a workout that was parsed stays parsed
 * even if nobody could be told, and a week that was recomputed stays
 * recomputed. This is the constitution's "Events Durable, Notifications Not" at
 * its narrowest point, so it is guaranteed here rather than asked of every
 * caller.
 *
 * The `await` is load-bearing, not style. `redis.publish` returns a promise, so
 * without it the catch cannot see a rejection — it escapes as an unhandled
 * rejection instead, and the swallowing fails in exactly the case it exists
 * for. Verified by forcing a publish to reject.
 *
 * The logger is a parameter and required. Swallowing is the point, but
 * swallowing *silently* would make a channel that has stopped working
 * indistinguishable from a quiet one. It is passed in rather than created here
 * only so the line carries the right `svc` — both apps log through
 * `createLogger` anyway (apps/api via its Nest `StructuredLogger` adapter), so
 * this is the same logger either way, and no caller needs a wrapper to supply
 * it.
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
