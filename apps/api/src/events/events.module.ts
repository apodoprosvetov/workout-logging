import { Module } from '@nestjs/common';

import { ConnectionRegistry } from './connection-registry';
import { EventsController } from './events.controller';
import { NotificationsPublisher } from './notifications.publisher';
import { NotificationsSubscriber } from './notifications.subscriber';
import { OutboxRelayService } from './outbox-relay.service';
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
    // Not exported: nothing should reach into the relay. It is started by its
    // own lifecycle hook and the only way an event reaches the broker is by
    // being committed to the outbox table.
    OutboxRelayService,
  ],
  exports: [
    RabbitMqPublisherService,
    NotificationsPublisher,
    ConnectionRegistry,
    NotificationsSubscriber,
  ],
})
export class EventsModule {}
