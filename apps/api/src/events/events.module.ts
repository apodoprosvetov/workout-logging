import { Module } from '@nestjs/common';

import { ConnectionRegistry } from './connection-registry';
import { EventsController } from './events.controller';
import { NotificationsPublisher } from './notifications.publisher';
import { NotificationsSubscriber } from './notifications.subscriber';
import { RabbitMqPublisherService } from './rabbitmq-publisher.service';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [RedisModule, AuthModule],
  controllers: [EventsController],
  providers: [
    RabbitMqPublisherService,
    NotificationsPublisher,
    ConnectionRegistry,
    NotificationsSubscriber,
  ],
  exports: [
    RabbitMqPublisherService,
    NotificationsPublisher,
    ConnectionRegistry,
    NotificationsSubscriber,
  ],
})
export class EventsModule {}
