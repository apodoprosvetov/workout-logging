import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

// Sliding-window log via a Redis sorted set: drop entries older than the
// window, count what's left, and admit the new request only if under the
// limit — all in one Lua script so check+admit is atomic under concurrency.
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)

if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return 1
else
  return 0
end
`;

export interface RateLimitConfig {
  key: string;
  windowMs: number;
  limit: number;
}

export interface RateLimitResult {
  allowed: boolean;
}

export async function checkRateLimit(client: Redis, config: RateLimitConfig): Promise<RateLimitResult> {
  const now = Date.now();
  const member = `${now}-${randomUUID()}`;
  const result = await client.eval(
    SLIDING_WINDOW_SCRIPT,
    1,
    config.key,
    now,
    config.windowMs,
    config.limit,
    member,
  );
  return { allowed: result === 1 };
}

// FR-018: ingestion rate-limited to 30 requests/minute/user.
export const INGEST_RATE_LIMIT = { windowMs: 60_000, limit: 30 };

export function ingestRateLimitKey(userId: string): string {
  return `ratelimit:ingest:${userId}`;
}

export async function checkIngestRateLimit(client: Redis, userId: string): Promise<RateLimitResult> {
  return checkRateLimit(client, { key: ingestRateLimitKey(userId), ...INGEST_RATE_LIMIT });
}
