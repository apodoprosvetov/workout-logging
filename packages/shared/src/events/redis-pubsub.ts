import Redis from 'ioredis';

import { redisUrl } from '../db/redis';

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
