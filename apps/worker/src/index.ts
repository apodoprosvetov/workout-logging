import 'reflect-metadata';
import type { Channel } from 'amqplib';
import {
  connectRabbitMq,
  createMongooseConnection,
  createRedisClient,
  createTypeOrmDataSource,
  setupRabbitMqTopology,
} from '@workout-logging/shared';
import type { Connection as MongooseConnection } from 'mongoose';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { registerParserConsumer } from './parser/handler.js';
import { registerAnalyticsConsumer } from './analytics/handler.js';
import { log } from './logger.js';

export interface WorkerContext {
  dataSource: DataSource;
  mongoConnection: MongooseConnection;
  channel: Channel;
  redis: Redis;
}

// Each consumer pushes a function here that calls channel.consume() for its
// own queue (T031 parser, T047 analytics).
type ConsumerRegistration = (context: WorkerContext) => void;
const consumers: ConsumerRegistration[] = [registerParserConsumer, registerAnalyticsConsumer];

async function bootstrap(): Promise<void> {
  const dataSource = createTypeOrmDataSource();
  await dataSource.initialize();

  const mongoConnection = await createMongooseConnection();
  const redis = createRedisClient();

  const connection = await connectRabbitMq();
  const channel = await connection.createChannel();
  await setupRabbitMqTopology(channel);

  const context: WorkerContext = { dataSource, mongoConnection, channel, redis };
  for (const register of consumers) {
    register(context);
  }

  log.info('worker started', { consumers: consumers.length });

  // Guarded against firing twice — a double signal delivery (e.g. tsx watch's own
  // SIGINT forwarding, or the usual SIGTERM-then-SIGKILL from process managers)
  // would otherwise try to close an already-closing channel and crash.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutdown signal received', { signal });
    await channel.close();
    await connection.close();
    await mongoConnection.close();
    redis.disconnect();
    await dataSource.destroy();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((err: unknown) => {
  log.error('worker failed to start', { err });
  process.exit(1);
});
