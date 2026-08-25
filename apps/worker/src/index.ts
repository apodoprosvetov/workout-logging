import 'reflect-metadata';
import type { Channel } from 'amqplib';
import {
  connectRabbitMq,
  createMongooseConnection,
  createTypeOrmDataSource,
  setupRabbitMqTopology,
} from '@workout-logging/shared';
import type { Connection as MongooseConnection } from 'mongoose';
import type { DataSource } from 'typeorm';
import { registerParserConsumer } from './parser/handler.js';

export interface WorkerContext {
  dataSource: DataSource;
  mongoConnection: MongooseConnection;
  channel: Channel;
}

// Populated by later tasks (T031 parser handler, T047 analytics handler) — each
// pushes a function here that calls channel.consume() for its own queue.
type ConsumerRegistration = (context: WorkerContext) => void;
const consumers: ConsumerRegistration[] = [registerParserConsumer];

async function bootstrap(): Promise<void> {
  const dataSource = createTypeOrmDataSource();
  await dataSource.initialize();

  const mongoConnection = await createMongooseConnection();

  const connection = await connectRabbitMq();
  const channel = await connection.createChannel();
  await setupRabbitMqTopology(channel);

  const context: WorkerContext = { dataSource, mongoConnection, channel };
  for (const register of consumers) {
    register(context);
  }

  console.log(`apps/worker started (${consumers.length} consumer(s) registered)`);

  // Guarded against firing twice — a double signal delivery (e.g. tsx watch's own
  // SIGINT forwarding, or the usual SIGTERM-then-SIGKILL from process managers)
  // would otherwise try to close an already-closing channel and crash.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down...`);
    await channel.close();
    await connection.close();
    await mongoConnection.close();
    await dataSource.destroy();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((err: unknown) => {
  console.error('apps/worker failed to start', err);
  process.exit(1);
});
