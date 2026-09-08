import 'reflect-metadata';
import path from 'node:path';

import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { TestingModule, Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  connectRabbitMq,
  createMongooseConnection,
  createTypeOrmDataSource,
  mongoUri,
  typeOrmDataSourceOptions,
  User,
  WorkoutSource,
  WorkoutStatus,
  WORKOUT_PARSE_QUEUE,
} from '@workout-logging/shared';

import { IngestionService } from '../../src/workouts/ingestion.service';
import { WorkoutsModule } from '../../src/workouts/workouts.module';

import type { Channel, ChannelModel } from 'amqplib';

describe('IngestionService (integration, real Postgres + MongoDB + RabbitMQ)', () => {
  let moduleRef: TestingModule;
  let service: IngestionService;
  let amqpConnection: ChannelModel;
  let amqpChannel: Channel;
  let userId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ envFilePath: path.resolve(__dirname, '../../../../.env') }),
        TypeOrmModule.forRoot(typeOrmDataSourceOptions),
        MongooseModule.forRoot(mongoUri),
        WorkoutsModule,
      ],
    }).compile();
    // .compile() only instantiates providers — OnModuleInit hooks (which is how
    // RabbitMqPublisherService opens its channel) only run after .init().
    await moduleRef.init();
    service = moduleRef.get(IngestionService);

    // workouts.user_id is a real FK to users.id — needs an actual row, not a placeholder string.
    const ds = await createTypeOrmDataSource().initialize();
    const user = await ds.getRepository(User).save(
      ds.getRepository(User).create({ email: `ingestion-integration-${Date.now()}@example.com`, passwordHash: 'x' }),
    );
    userId = user.id;
    await ds.destroy();

    amqpConnection = await connectRabbitMq();
    amqpChannel = await amqpConnection.createChannel();
    await amqpChannel.purgeQueue(WORKOUT_PARSE_QUEUE);
  });

  afterAll(async () => {
    // Cleans up by user_id, not by tracking individual result IDs from each test —
    // robust even if a test throws partway through, after creating rows but before
    // the test body got a chance to record their IDs (this bit a debugging run).
    if (userId) {
      const ds = createTypeOrmDataSource();
      await ds.initialize();
      await ds.query('DELETE FROM workouts WHERE user_id = $1', [userId]);
      await ds.query('DELETE FROM users WHERE id = $1', [userId]);
      await ds.destroy();

      const conn = await createMongooseConnection();
      await conn.model('RawUpload').deleteMany({ user_id: userId });
      await conn.close();
    }
    await amqpChannel.close();
    await amqpConnection.close();
    await moduleRef.close();
  });

  it('creates a pending workout row + a raw_uploads doc, and publishes workout.uploaded', async () => {
    const result = await service.ingest({ userId, text: 'bench press 80kg x8', source: WorkoutSource.WEB });
    expect(result.status).toBe(WorkoutStatus.PENDING);

    const ds = createTypeOrmDataSource();
    await ds.initialize();
    const [workoutRow] = (await ds.query('SELECT * FROM workouts WHERE id = $1', [result.workoutId])) as Array<
      Record<string, unknown>
    >;
    await ds.destroy();
    expect(workoutRow.has_text).toBe(true);
    expect(workoutRow.has_image).toBe(false);
    expect(workoutRow.status).toBe('pending');
    expect(workoutRow.source).toBe('web');
    const rawInputRef = workoutRow.raw_input_ref as string;

    const mongoConn = await createMongooseConnection();
    const rawUpload = await mongoConn.model('RawUpload').findById(rawInputRef);
    await mongoConn.close();
    expect(rawUpload?.get('text')).toBe('bench press 80kg x8');
    expect(rawUpload?.get('user_id')).toBe(userId);

    // The publish is fire-and-forget from the service's perspective — give the
    // broker a beat to actually route it before asserting on queue contents.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const msg = await amqpChannel.get(WORKOUT_PARSE_QUEUE);
    if (!msg) throw new Error('expected a message on workout.parse.q');
    const event = JSON.parse(msg.content.toString()) as {
      workout_id: string;
      user_id: string;
      raw_upload_ref: string;
      event_id: string;
    };
    expect(event.workout_id).toBe(result.workoutId);
    expect(event.user_id).toBe(userId);
    expect(event.raw_upload_ref).toBe(rawInputRef);
    expect(typeof event.event_id).toBe('string');
    amqpChannel.ack(msg);
  });

  it('throws when neither text nor an image is provided (data-model.md validation rule)', async () => {
    await expect(service.ingest({ userId, source: WorkoutSource.WEB })).rejects.toThrow();
  });
});
