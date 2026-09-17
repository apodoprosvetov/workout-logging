import { Inject, Module, OnModuleDestroy } from '@nestjs/common';

import { createRedisClient } from '@workout-logging/shared';

import type Redis from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

@Module({
  providers: [{ provide: REDIS_CLIENT, useFactory: () => createRedisClient() }],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  // A `useFactory` provider gets no teardown of its own, so without this the
  // connection outlives the module that created it. Nothing noticed while the
  // process was meant to run for weeks — but an open socket keeps Node's event
  // loop alive, so any test building a module that reaches this one hung until
  // its runner gave up instead of exiting.
  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      // `quit()` waits for the server to acknowledge. That acknowledgement
      // never arrives if the socket is already broken, or if the client is
      // still mid-connect when shutdown starts — a real case here, since
      // nothing awaits the initial connection. Shutdown must not block on it,
      // so drop the socket outright instead.
      this.redis.disconnect();
    }
  }
}
