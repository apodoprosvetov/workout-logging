import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Channel, ChannelModel } from 'amqplib';
import { connectRabbitMq, setupRabbitMqTopology, WORKOUT_EVENTS_EXCHANGE } from '@workout-logging/shared';

@Injectable()
export class RabbitMqPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqPublisherService.name);
  private connection!: ChannelModel;
  private channel!: Channel;

  async onModuleInit(): Promise<void> {
    this.connection = await connectRabbitMq();
    this.channel = await this.connection.createChannel();
    await setupRabbitMqTopology(this.channel);
    this.logger.log('RabbitMQ publisher connected, topology asserted');
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel?.close();
    await this.connection?.close();
  }

  publish<T extends object>(routingKey: string, payload: T): void {
    this.channel.publish(WORKOUT_EVENTS_EXCHANGE, routingKey, Buffer.from(JSON.stringify(payload)), {
      persistent: true,
    });
  }
}
