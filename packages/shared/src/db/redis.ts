import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import Redis from 'ioredis';

// CLI convenience only — no-op once a real process (apps/api, apps/worker) has already loaded its own env.
if (!process.env.REDIS_URL) {
  loadEnv({ path: path.resolve(__dirname, '../../../../.env') });
}

export const redisUrl = process.env.REDIS_URL as string;

// Used directly by both apps/api and apps/worker — ioredis needs no Nest-specific wiring.
export function createRedisClient(): Redis {
  return new Redis(redisUrl);
}
