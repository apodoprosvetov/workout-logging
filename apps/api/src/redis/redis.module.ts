import { Module } from '@nestjs/common';

import { createRedisClient } from '@workout-logging/shared';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

@Module({
  providers: [{ provide: REDIS_CLIENT, useFactory: () => createRedisClient() }],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
