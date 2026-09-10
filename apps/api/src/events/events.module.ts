import { Module } from '@nestjs/common';
import { RedisModule } from 'src/redis/redis.module';

import { ConnectionRegistry } from './connection-registry';
import { NotificationsPublisher } from './notifications.publisher';
import { RabbitMqPublisherService } from './rabbitmq-publisher.service';

@Module({
  imports: [RedisModule],
  providers: [RabbitMqPublisherService, NotificationsPublisher, ConnectionRegistry],
  exports: [RabbitMqPublisherService, NotificationsPublisher, ConnectionRegistry],
})
export class EventsModule {}
