import { Injectable, Inject } from '@nestjs/common';
import Redis from 'ioredis';

import { ChangeNotification, createLogger, publishNotification } from '@workout-logging/shared';

import { REDIS_CLIENT } from '../redis/redis.module';

// Exists only to hand `publishNotification` the injected Redis client — the
// publishing itself, the channel name, the encoding and the never-throw
// guarantee all live in packages/shared, shared with apps/worker, which
// publishes to the same channels. There is no apps/api variant of any of that,
// and there must not be: one line of drift between the two would be a
// notification nobody receives, with no error anywhere to say so.
//
// `createLogger('api')` rather than Nest's `new Logger(...)`: the shared
// publisher takes an AppLogger, and apps/api's Nest logging is already an
// adapter onto exactly this (common/structured-logger.ts), so the line comes
// out as the same `{ts,level,svc:"api",...}` object either way.
@Injectable()
export class NotificationsPublisher {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}
  private readonly log = createLogger('api');

  async publish(notification: ChangeNotification): Promise<void> {
    await publishNotification(this.redis, notification, this.log);
  }
}
