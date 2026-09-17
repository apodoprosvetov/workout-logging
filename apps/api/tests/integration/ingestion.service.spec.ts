import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { ConfigModule } from '@nestjs/config';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { TestingModule, Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Model } from 'mongoose';
import { EntityManager } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createMongooseConnection,
  createTypeOrmDataSource,
  getWorkoutImagesBucket,
  RawUploadDocument,
  mongoUri,
  typeOrmDataSourceOptions,
  User,
  WorkoutSource,
  WorkoutStatus,
  WORKOUT_UPLOADED_ROUTING_KEY,
} from '@workout-logging/shared';

import { OutboxRelayService } from '../../src/events/outbox-relay.service';
import { IngestionService } from '../../src/workouts/ingestion.service';
import { WorkoutsModule } from '../../src/workouts/workouts.module';

// No RabbitMQ any more: since T058 the request path writes to the `outbox`
// table instead of publishing, so this suite touches Postgres and MongoDB only.
// That also retires the race this test used to lose against a running dev
// worker — both competed for workout.parse.q, and nothing here reads it now.
describe('IngestionService (integration, real Postgres + MongoDB)', () => {
  let moduleRef: TestingModule;
  let service: IngestionService;
  let rawUploadModel: Model<RawUploadDocument>;
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
    rawUploadModel = moduleRef.get<Model<RawUploadDocument>>(getModelToken('RawUpload'), {
      strict: false,
    });

    // Stop the relay before any test runs. WorkoutsModule imports EventsModule,
    // so T059's relay starts with this graph and would publish the very rows
    // these tests assert are still waiting — a race the suite would lose
    // occasionally rather than reliably, which is the worst kind. This suite is
    // about what ingest writes; what the relay then does with it has its own
    // spec.
    await moduleRef.get(OutboxRelayService).onModuleDestroy();

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
    expect(row.occurred_at).toBeInstanceOf(Date);
    // Deliberately no assertion on `published_at`. It was here until T059, and
    // it was a claim about the *relay* inside a test about ingest: now that a
    // relay exists, whether a row has been picked up yet depends on another
    // spec file's timing. That a fresh row starts unpublished and then gets
    // published is outbox-relay.service.spec.ts's to prove.

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

  // T056. The task's original framing — "with the publish forced to fail" —
  // describes a branch that no longer exists: T058 took the publish out of the
  // request path, exactly as tasks.md predicted it would. What survives, and is
  // what these cover, is the half an outbox cannot reach: GridFS and
  // `raw_uploads` are written to MongoDB *before* a Postgres transaction that
  // can still fail, and no transaction spans both databases.
  describe('compensation after a failed ingest (T056)', () => {
    it('leaves no workout row, no raw_uploads doc and no GridFS blob behind', async () => {
      const before = await countScoped();
      const startedAt = new Date();

      // A payload unique to this run. GridFS files carry no user id, so a
      // bucket-wide count is not ours to assert on — sibling spec files upload
      // images concurrently, and a global before/after comparison failed two
      // full runs in three for reasons that had nothing to do with this code.
      // Length plus upload time is narrow enough to name our own blob.
      const marker = Buffer.from(`compensation-probe-${randomUUID()}`);

      const spy = vi
        .spyOn(EntityManager.prototype, 'insert')
        .mockRejectedValue(new Error('outbox insert failed'));

      try {
        await expect(
          service.ingest({
            userId,
            text: 'clean and jerk 70kg x3',
            // An image, deliberately: without one the GridFS half of the
            // compensation is never exercised, and it is the half with no
            // transaction behind it.
            imageBuffers: [marker],
            source: WorkoutSource.WEB,
          }),
        ).rejects.toMatchObject({ status: 503 });
      } finally {
        spy.mockRestore();
      }

      // The Postgres and Mongo rows are scoped by user id; the blob is scoped
      // by its own size and upload window. A blob nothing references is
      // invisible to every screen and every query, which is precisely why it
      // would go unnoticed without an assertion here.
      expect(await countScoped()).toEqual(before);
      expect(await ourBlobsSince(startedAt, marker.length)).toBe(0);
    });

    it('still reports 503 when the compensation itself fails, and never masks the error', async () => {
      // **The decision T056 asks to record, asserted rather than only
      // commented**: if the cleanup cannot run — Mongo goes away between the
      // write and the rollback — the orphan is logged and accepted, and the
      // caller still gets a 503 telling them the retry is safe.
      //
      // The alternative would be to surface the cleanup's own error, which
      // tells the caller nothing they can act on and hides the one thing they
      // need: that nothing durable was created for them. Nothing retries the
      // orphan today; it costs storage and no correctness, and a durable
      // cleanup queue is a second outbox to justify the rarer half of a rare
      // case.
      const insertSpy = vi
        .spyOn(EntityManager.prototype, 'insert')
        .mockRejectedValue(new Error('outbox insert failed'));
      // Break the undo as well, with a distinctive error: if this one ever
      // reaches the caller, the compensation is rethrowing and the test fails
      // on the message rather than passing quietly.
      //
      // The Mongo model, not `EntityManager.delete`. An earlier version of this
      // test mocked the latter and passed vacuously: T058 moved the workouts
      // row into the transaction, so `undo` no longer deletes anything through
      // TypeORM and that spy broke nothing at all. A mutation check caught it —
      // rethrowing from the real compensation left the suite green.
      const deleteSpy = vi
        .spyOn(rawUploadModel, 'deleteOne')
        .mockRejectedValue(new Error('compensation itself failed')) as unknown as {
        mockRestore: () => void;
      };

      try {
        await expect(
          service.ingest({ userId, text: 'row 60kg x10', source: WorkoutSource.WEB }),
        ).rejects.toMatchObject({ status: 503 });
      } finally {
        insertSpy.mockRestore();
        deleteSpy.mockRestore();
      }
    });
  });

  /** Everything this user owns across the three stores. */
  async function countScoped(): Promise<{
    workouts: number;
    outbox: number;
    rawUploads: number;
  }> {
    const counts = await countWorkoutsAndOutbox();
    const mongo = await createMongooseConnection();
    const rawUploads = await mongo.model('RawUpload').countDocuments({ user_id: userId });
    await mongo.close();
    return { ...counts, rawUploads };
  }

  /** Blobs of exactly this size uploaded since `since` — i.e. ours, and only ours. */
  async function ourBlobsSince(since: Date, length: number): Promise<number> {
    const mongo = await createMongooseConnection();
    const found = await getWorkoutImagesBucket(mongo)
      .find({ length, uploadDate: { $gte: since } })
      .toArray();
    await mongo.close();
    return found.length;
  }

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
