import 'reflect-metadata';
import path from 'node:path';

import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { TestingModule, Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createMongooseConnection,
  createTypeOrmDataSource,
  mongoUri,
  typeOrmDataSourceOptions,
  User,
  WorkoutSource,
  WorkoutStatus,
  WORKOUT_UPLOADED_ROUTING_KEY,
} from '@workout-logging/shared';

import { IngestionService } from '../../src/workouts/ingestion.service';
import { WorkoutsModule } from '../../src/workouts/workouts.module';

// No RabbitMQ any more: since T058 the request path writes to the `outbox`
// table instead of publishing, so this suite touches Postgres and MongoDB only.
// That also retires the race this test used to lose against a running dev
// worker — both competed for workout.parse.q, and nothing here reads it now.
describe('IngestionService (integration, real Postgres + MongoDB)', () => {
  let moduleRef: TestingModule;
  let service: IngestionService;
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
    const user = await ds
      .getRepository(User)
      .save(
        ds
          .getRepository(User)
          .create({ email: `ingestion-integration-${Date.now()}@example.com`, passwordHash: 'x' }),
      );
    userId = user.id;
    await ds.destroy();
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
    // Also deletes this user's outbox rows: they are keyed by event id, not by
    // user, so the FK-style cleanup above cannot reach them and they would
    // otherwise accumulate one per run.
    const outboxDs = createTypeOrmDataSource();
    await outboxDs.initialize();
    await outboxDs.query(`DELETE FROM outbox WHERE payload->>'user_id' = $1`, [userId]);
    await outboxDs.destroy();

    await moduleRef.close();
  });

  it('creates a pending workout row + a raw_uploads doc, and queues workout.uploaded in the outbox', async () => {
    const result = await service.ingest({
      userId,
      text: 'bench press 80kg x8',
      source: WorkoutSource.WEB,
    });
    expect(result.status).toBe(WorkoutStatus.PENDING);

    const ds = createTypeOrmDataSource();
    await ds.initialize();
    const [workoutRow] = (await ds.query('SELECT * FROM workouts WHERE id = $1', [
      result.workoutId,
    ])) as Array<Record<string, unknown>>;
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

    // Since T058 the request path does not publish: the event is written to
    // the `outbox` table in the same transaction as the workout row, and the
    // relay (T059) is what puts it on the exchange. Asserting on the queue
    // here would now be asserting on the relay, which is a different test —
    // and, until T059 exists, on nothing at all.
    //
    // No sleep any more either. The old 300ms was waiting for the broker to
    // route an asynchronous publish; a committed row needs no such grace, and
    // the wait was a race the test could only ever lose slowly.
    const outboxDs = createTypeOrmDataSource();
    await outboxDs.initialize();
    const rows = (await outboxDs.query(`SELECT * FROM outbox WHERE payload->>'workout_id' = $1`, [
      result.workoutId,
    ])) as Array<Record<string, unknown>>;
    await outboxDs.destroy();

    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.routing_key).toBe(WORKOUT_UPLOADED_ROUTING_KEY);
    // Null is the queue: the relay has not taken it yet (see OutboxEvent).
    expect(row.published_at).toBeNull();
    expect(row.occurred_at).toBeInstanceOf(Date);

    const payload = row.payload as {
      workout_id: string;
      user_id: string;
      raw_upload_ref: string;
      event_id: string;
    };
    expect(payload.workout_id).toBe(result.workoutId);
    expect(payload.user_id).toBe(userId);
    expect(payload.raw_upload_ref).toBe(rawInputRef);
    // The envelope's id is the row's primary key — one event, one row.
    expect(row.event_id).toBe(payload.event_id);
  });

  it('commits the workout row and its outbox event together, or not at all', async () => {
    // The claim T058 exists to make. Counting both sides across a successful
    // ingest is the cheap half; the half that matters is that they move
    // together, which a single transaction is the only way to guarantee — a
    // save followed by an insert could leave the first without the second.
    const before = await countWorkoutsAndOutbox();

    await service.ingest({ userId, text: 'deadlift 140kg x3', source: WorkoutSource.WEB });

    const after = await countWorkoutsAndOutbox();
    expect(after.workouts).toBe(before.workouts + 1);
    expect(after.outbox).toBe(before.outbox + 1);
  });

  it('rolls the workout row back when the outbox insert fails', async () => {
    // The claim the previous test cannot make. Counting after a success shows
    // the two rows appear together; only a forced failure shows they *cannot*
    // come apart — which is the entire point of the transaction, and the bug a
    // save-then-insert would reintroduce silently.
    //
    // Spying on EntityManager's prototype rather than on a manager instance:
    // the transactional manager is created by TypeORM inside `transaction()`
    // and never handed to the test, so the prototype is the only seam that
    // reaches it.
    const before = await countWorkoutsAndOutbox();
    const spy = vi
      .spyOn(EntityManager.prototype, 'insert')
      .mockRejectedValue(new Error('outbox insert failed'));

    try {
      await expect(
        service.ingest({ userId, text: 'overhead press 50kg x5', source: WorkoutSource.WEB }),
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      spy.mockRestore();
    }

    const after = await countWorkoutsAndOutbox();
    expect(after).toEqual(before);
  });

  async function countWorkoutsAndOutbox(): Promise<{ workouts: number; outbox: number }> {
    const ds = createTypeOrmDataSource();
    await ds.initialize();
    const [{ n: workouts }] = (await ds.query(
      'SELECT COUNT(*)::int AS n FROM workouts WHERE user_id = $1',
      [userId],
    )) as Array<{ n: number }>;
    const [{ n: outbox }] = (await ds.query(
      `SELECT COUNT(*)::int AS n FROM outbox WHERE payload->>'user_id' = $1`,
      [userId],
    )) as Array<{ n: number }>;
    await ds.destroy();
    return { workouts, outbox };
  }

  it('throws when neither text nor an image is provided (data-model.md validation rule)', async () => {
    await expect(service.ingest({ userId, source: WorkoutSource.WEB })).rejects.toThrow();
  });
});
