import { Module } from '@nestjs/common';
import { RedisModule } from 'src/redis/redis.module';

import { ConnectionRegistry } from './connection-registry';
import { NotificationsPublisher } from './notifications.publisher';
import { NotificationsSubscriber } from './notifications.subscriber';
import { RabbitMqPublisherService } from './rabbitmq-publisher.service';

@Module({
  imports: [RedisModule],
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
