import { Injectable, Inject, Logger } from '@nestjs/common';
import Redis from 'ioredis';

import { ChangeNotification, getEventsChannelName } from '@workout-logging/shared';

import { REDIS_CLIENT } from '../redis/redis.module';

@Injectable()
export class NotificationsPublisher {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}
  private readonly logger = new Logger(NotificationsPublisher.name);

  async publish(notification: ChangeNotification): Promise<void> {
    try {
      await this.redis.publish(
        getEventsChannelName(notification.user_id),
        JSON.stringify(notification),
      );
    } catch (err) {
      this.logger.error(
        `Redis publish failed: ${notification.type} ${notification.event_id} for ${notification.user_id}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }
}
