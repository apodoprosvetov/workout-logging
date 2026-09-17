import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ChannelModel, ConfirmChannel } from 'amqplib';

import {
  connectRabbitMq,
  setupRabbitMqTopology,
  WORKOUT_EVENTS_EXCHANGE,
} from '@workout-logging/shared';

@Injectable()
export class RabbitMqPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqPublisherService.name);
  private connection!: ChannelModel;
  private channel!: ConfirmChannel;

  async onModuleInit(): Promise<void> {
    this.connection = await connectRabbitMq();
    this.channel = await this.connection.createConfirmChannel();
    await setupRabbitMqTopology(this.channel);
    this.logger.log('RabbitMQ publisher connected, topology asserted');
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel?.close();
    await this.connection?.close();
  }

  publish<T extends object>(routingKey: string, payload: T): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.channel.publish(
        WORKOUT_EVENTS_EXCHANGE,
        routingKey,
        Buffer.from(JSON.stringify(payload)),
        {
          persistent: true,
        },
        (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        },
      );
    });
  }
}
