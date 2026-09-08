import 'reflect-metadata';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  connectRabbitMq,
  createMongooseConnection,
  createRedisClient,
  createTypeOrmDataSource,
  downloadWorkoutImage,
  getWorkoutImagesBucket,
  retryTiersFor,
  seedExerciseCatalog,
  setupRabbitMqTopology,
  uploadWorkoutImage,
  User,
  Workout,
  WorkoutSource,
  WorkoutStatus,
  WORKOUT_ANALYTICS_QUEUE,
  WORKOUT_DLQ,
  WORKOUT_EVENTS_EXCHANGE,
  WORKOUT_PARSE_QUEUE,
  WORKOUT_PARSED_ROUTING_KEY,
  WORKOUT_UPLOADED_ROUTING_KEY,
} from '@workout-logging/shared';

import { registerParserConsumer } from '../../src/parser/handler.js';
import { getRetryAttempt, handleParseFailure } from '../../src/parser/retry.js';

import type { WorkerContext } from '../../src/index.js';
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import type { Redis } from 'ioredis';
import type { Connection as MongooseConnection } from 'mongoose';
import type { DataSource } from 'typeorm';


// A real 1x1 PNG. Since T044 the parser sniffs each image's media type from its
// magic bytes (image-media-type.ts) and rejects anything unrecognised into the
// retry path, so the old `Buffer.from('fake-image-N')` placeholder no longer
// survives a parse. Blank content is fine here: these tests assert the vision
// branch runs and reaches a terminal status, not that a workout is legible in
// the pixels (that's quickstart.md's manual US3 check).
const PARSED_MIRROR_QUEUE = 'test.parser.parsed-mirror';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// Skipped without a real ANTHROPIC_API_KEY: this suite calls the actual
// Claude/DeepSeek API, so it can't run in CI (spec 002's ci.yml deliberately
// doesn't provision a real key — running paid, non-deterministic AI calls on
// every push/PR isn't worth it). Still runs locally for anyone with a real
// key in their .env.
describe.skipIf(!process.env.ANTHROPIC_API_KEY)(
  'parser worker (integration, real Postgres + MongoDB + RabbitMQ + Claude)',
  () => {
  let dataSource: DataSource;
  let mongoConnection: MongooseConnection;
  let amqpConnection: ChannelModel;
  let channel: Channel;
  let redis: Redis;
  let context: WorkerContext;
  let userId: string;

  beforeAll(async () => {
    // The matched-exercise assertions below depend on exercise_catalog being
    // seeded with the current schema (normalized_aliases) — seed it rather than
    // assume a hand-run `npm run seed:exercises`.
    await seedExerciseCatalog();

    dataSource = createTypeOrmDataSource();
    await dataSource.initialize();
    mongoConnection = await createMongooseConnection();
    amqpConnection = await connectRabbitMq();
    channel = await amqpConnection.createChannel();
    await setupRabbitMqTopology(channel);
    await purgeAllWorkoutQueues();
    redis = createRedisClient();

    // Own copy of every workout.parsed — so "the parser published it" can be
    // asserted regardless of what else (a running dev analytics worker, T047)
    // is draining the real workout.analytics.q.
    await channel.assertQueue(PARSED_MIRROR_QUEUE, { durable: false });
    await channel.bindQueue(PARSED_MIRROR_QUEUE, WORKOUT_EVENTS_EXCHANGE, WORKOUT_PARSED_ROUTING_KEY);
    await channel.purgeQueue(PARSED_MIRROR_QUEUE);

    context = { dataSource, mongoConnection, channel, redis };
    registerParserConsumer(context);

    const user = await dataSource.getRepository(User).save(
      dataSource
        .getRepository(User)
        .create({ email: `parser-integration-${Date.now()}@example.com`, passwordHash: 'x' }),
    );
    userId = user.id;
  });

  afterAll(async () => {
    await dataSource.query(
      `DELETE FROM sets WHERE workout_exercise_id IN
         (SELECT id FROM workout_exercises WHERE workout_id IN (SELECT id FROM workouts WHERE user_id = $1))`,
      [userId],
    );
    await dataSource.query(
      'DELETE FROM workout_exercises WHERE workout_id IN (SELECT id FROM workouts WHERE user_id = $1)',
      [userId],
    );
    await dataSource.query('DELETE FROM workouts WHERE user_id = $1', [userId]);
    await dataSource.query('DELETE FROM users WHERE id = $1', [userId]);
    // exercises rows (e.g. bench-press) are shared reference data — not deleted.
    await dataSource.destroy();

    await mongoConnection.model('RawUpload').deleteMany({ user_id: userId });
    await mongoConnection.close();
    redis.disconnect();

    await purgeAllWorkoutQueues();
    await channel.deleteQueue('test.scratch.retry-routing').catch(() => undefined);
    await channel.deleteQueue(PARSED_MIRROR_QUEUE).catch(() => undefined);
    await channel.close();
    await amqpConnection.close();
  });

  // Clears the primary queues, the DLQ, *and* every retry tier — a failed parse
  // left mid-cycle in workout.parse.q.retry.30s would otherwise keep spamming
  // "not found" against a wiped DB long after the suite finishes.
  async function purgeAllWorkoutQueues(): Promise<void> {
    const names = [
      WORKOUT_PARSE_QUEUE,
      WORKOUT_ANALYTICS_QUEUE,
      WORKOUT_DLQ,
      ...retryTiersFor(WORKOUT_PARSE_QUEUE).map((t) => t.queue),
      ...retryTiersFor(WORKOUT_ANALYTICS_QUEUE).map((t) => t.queue),
    ];
    for (const name of names) {
      await channel.purgeQueue(name).catch(() => undefined);
    }
  }

  async function seedWorkout(
    text: string,
    opts: { performedAt?: Date; performedAtExplicit?: boolean } = {},
  ): Promise<{ workoutId: string; rawUploadRef: string }> {
    const rawUpload = await mongoConnection
      .model('RawUpload')
      .create({ user_id: userId, text, image_refs: [], ai_response_raw: null });
    const workout = await dataSource.getRepository(Workout).save(
      dataSource.getRepository(Workout).create({
        userId,
        source: WorkoutSource.WEB,
        hasText: true,
        hasImage: false,
        rawInputRef: rawUpload._id.toString(),
        status: WorkoutStatus.PENDING,
        performedAt: opts.performedAt ?? new Date(),
        performedAtExplicit: opts.performedAtExplicit ?? false,
      }),
    );
    return { workoutId: workout.id, rawUploadRef: rawUpload._id.toString() };
  }

  async function seedWorkoutWithImages(
    text: string,
    imageCount: number,
  ): Promise<{ workoutId: string; rawUploadRef: string; imageRefs: string[] }> {
    const bucket = getWorkoutImagesBucket(mongoConnection);
    const imageRefs = await Promise.all(
      Array.from({ length: imageCount }, (_, i) => uploadWorkoutImage(bucket, TINY_PNG, `image-${i}.png`)),
    );
    const rawUpload = await mongoConnection
      .model('RawUpload')
      .create({ user_id: userId, text: text || null, image_refs: imageRefs, ai_response_raw: null });
    const workout = await dataSource.getRepository(Workout).save(
      dataSource.getRepository(Workout).create({
        userId,
        source: WorkoutSource.WEB,
        hasText: !!text,
        hasImage: true,
        rawInputRef: rawUpload._id.toString(),
        status: WorkoutStatus.PENDING,
        performedAt: new Date(),
        performedAtExplicit: false,
      }),
    );
    return { workoutId: workout.id, rawUploadRef: rawUpload._id.toString(), imageRefs };
  }

  function publishUploaded(workoutId: string, rawUploadRef: string, eventId: string = randomUUID()): void {
    channel.publish(
      WORKOUT_EVENTS_EXCHANGE,
      WORKOUT_UPLOADED_ROUTING_KEY,
      Buffer.from(
        JSON.stringify({
          event_id: eventId,
          user_id: userId,
          workout_id: workoutId,
          raw_upload_ref: rawUploadRef,
          occurred_at: new Date().toISOString(),
        }),
      ),
      { persistent: true },
    );
  }

  // Drains PARSED_MIRROR_QUEUE (which gets its own copy of every workout.parsed,
  // so it's immune to the real workout.analytics.q's consumers) looking for the
  // event for `workoutId`, tolerating other tests' events and publish latency.
  async function drainMirrorFor(
    workoutId: string,
    timeoutMs = 5000,
  ): Promise<{ workout_id: string; exercise_count: number } | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = await channel.get(PARSED_MIRROR_QUEUE, { noAck: true });
      if (msg) {
        const event = JSON.parse(msg.content.toString()) as { workout_id: string; exercise_count: number };
        if (event.workout_id === workoutId) return event;
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  }

  async function waitForStatus(workoutId: string, timeoutMs = 20000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [row] = (await dataSource.query('SELECT status FROM workouts WHERE id = $1', [workoutId])) as Array<{
        status: string;
      }>;
      if (row.status !== 'pending') return row.status;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(`workout ${workoutId} still pending after ${timeoutMs}ms`);
  }

  it('parses a matched exercise end-to-end: parsed status, exercises/sets written, workout.parsed published', async () => {
    const { workoutId, rawUploadRef } = await seedWorkout('bench press 80kg x8, x8, x6');
    publishUploaded(workoutId, rawUploadRef);

    const status = await waitForStatus(workoutId);
    expect(status).toBe('parsed');

    const [workoutExercise] = (await dataSource.query(
      `SELECT we.exercise_order, e.slug, e.name FROM workout_exercises we
       JOIN exercises e ON e.id = we.exercise_id WHERE we.workout_id = $1`,
      [workoutId],
    )) as Array<{ slug: string; name: string }>;
    expect(workoutExercise.slug).toBe('bench-press');

    const sets = (await dataSource.query(
      `SELECT set_order, weight, reps, unit FROM sets s
       JOIN workout_exercises we ON we.id = s.workout_exercise_id WHERE we.workout_id = $1
       ORDER BY set_order`,
      [workoutId],
    )) as Array<{ weight: string; reps: number; unit: string }>;
    expect(sets).toHaveLength(3);
    expect(Number(sets[0].weight)).toBe(80);
    expect(sets[0].reps).toBe(8);
    expect(sets[2].reps).toBe(6);
    expect(sets[0].unit).toBe('kg');

    const parsedEvent = await drainMirrorFor(workoutId);
    expect(parsedEvent, 'no workout.parsed event for this workout').not.toBeNull();
    expect(parsedEvent?.exercise_count).toBe(1);
  }, 25000);

  it('records weight 0 for a bodyweight set with no weight mentioned, rather than dropping it or inventing a value', async () => {
    const { workoutId, rawUploadRef } = await seedWorkout('Підйом ніг у висі:\nСет 1: 8 повторень.');
    publishUploaded(workoutId, rawUploadRef);

    await waitForStatus(workoutId); // matched or needs_review — either way the set must be recorded

    const sets = (await dataSource.query(
      `SELECT weight, reps FROM sets s
       JOIN workout_exercises we ON we.id = s.workout_exercise_id WHERE we.workout_id = $1`,
      [workoutId],
    )) as Array<{ weight: string; reps: number }>;
    expect(sets).toHaveLength(1);
    expect(Number(sets[0].weight)).toBe(0);
    expect(sets[0].reps).toBe(8);
  }, 25000);

  it('extracts an embedded name and date from raw text and applies them when performedAt was not explicit', async () => {
    const { workoutId, rawUploadRef } = await seedWorkout(
      'Низ А - 09.08.2026\nПрисідання:\nСет 1: 8 повторень, вага 20 кг',
    );
    publishUploaded(workoutId, rawUploadRef);

    await waitForStatus(workoutId);

    const [row] = (await dataSource.query('SELECT name, performed_at FROM workouts WHERE id = $1', [
      workoutId,
    ])) as Array<{ name: string | null; performed_at: Date }>;
    expect(row.name).toBe('Низ А');
    expect(row.performed_at.toISOString().slice(0, 10)).toBe('2026-08-09');
  }, 25000);

  it('does not overwrite an explicitly client-supplied performedAt even when the text has a different date', async () => {
    const explicitDate = new Date('2020-01-15T00:00:00.000Z');
    const { workoutId, rawUploadRef } = await seedWorkout(
      'Низ А - 09.08.2026\nПрисідання:\nСет 1: 8 повторень, вага 20 кг',
      { performedAt: explicitDate, performedAtExplicit: true },
    );
    publishUploaded(workoutId, rawUploadRef);

    await waitForStatus(workoutId);

    const [row] = (await dataSource.query('SELECT performed_at FROM workouts WHERE id = $1', [
      workoutId,
    ])) as Array<{ performed_at: Date }>;
    expect(row.performed_at.toISOString()).toBe(explicitDate.toISOString());
  }, 25000);

  it('leaves name null when the text has no embedded label', async () => {
    const { workoutId, rawUploadRef } = await seedWorkout('bench press 80kg x8, x8, x6');
    publishUploaded(workoutId, rawUploadRef);

    await waitForStatus(workoutId);

    const [row] = (await dataSource.query('SELECT name FROM workouts WHERE id = $1', [workoutId])) as Array<{
      name: string | null;
    }>;
    expect(row.name).toBeNull();
  }, 25000);

  it('flags needs_review for an exercise not in the catalog, but still records it', async () => {
    const { workoutId, rawUploadRef } = await seedWorkout('zercher squat 60kg x5');
    publishUploaded(workoutId, rawUploadRef);

    const status = await waitForStatus(workoutId);
    expect(status).toBe('needs_review');

    const [workoutExercise] = (await dataSource.query(
      'SELECT exercise_id FROM workout_exercises WHERE workout_id = $1',
      [workoutId],
    )) as Array<{ exercise_id: string }>;
    expect(workoutExercise).toBeDefined();
  }, 25000);

  it('is idempotent: redelivering the same event_id does not duplicate exercises/sets', async () => {
    const { workoutId, rawUploadRef } = await seedWorkout('deadlift 120kg x3');
    const eventId = randomUUID();
    publishUploaded(workoutId, rawUploadRef, eventId);
    await waitForStatus(workoutId);

    const countBefore = (
      (await dataSource.query('SELECT count(*)::int FROM workout_exercises WHERE workout_id = $1', [
        workoutId,
      ])) as Array<{ count: number }>
    )[0].count;

    // Redeliver the identical event — simulates a RabbitMQ at-least-once redelivery.
    publishUploaded(workoutId, rawUploadRef, eventId);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const countAfter = (
      (await dataSource.query('SELECT count(*)::int FROM workout_exercises WHERE workout_id = $1', [
        workoutId,
      ])) as Array<{ count: number }>
    )[0].count;
    expect(countAfter).toBe(countBefore);
  }, 25000);

  // ---- T044: image / vision branch (research.md #8, #14) ----

  it('downloadWorkoutImage round-trips the stored bytes, and rejects when the ref does not resolve', async () => {
    const bucket = getWorkoutImagesBucket(mongoConnection);
    const ref = await uploadWorkoutImage(bucket, TINY_PNG, 'roundtrip.png');

    const back = await downloadWorkoutImage(bucket, ref);
    expect(Buffer.compare(back, TINY_PNG)).toBe(0);

    // A ref that doesn't resolve must reject (→ T032 retry/DLQ), not hang or
    // resolve empty — images are guaranteed present until a terminal status.
    await bucket.delete(new mongoConnection.base.mongo.ObjectId(ref));
    await expect(downloadWorkoutImage(bucket, ref)).rejects.toThrow();
    await expect(downloadWorkoutImage(bucket, 'not-a-valid-objectid')).rejects.toThrow();
  });

  it('parses a workout submitted as an image only (no text) via the vision model, and stores the raw AI response', async () => {
    const { workoutId, rawUploadRef } = await seedWorkoutWithImages('', 1);
    publishUploaded(workoutId, rawUploadRef);

    // A terminal status means the vision call ran and returned, rather than
    // throwing the image into the retry loop.
    const status = await waitForStatus(workoutId);
    expect(['parsed', 'needs_review']).toContain(status);

    const rawUpload = await mongoConnection.model('RawUpload').findById(rawUploadRef);
    const aiResponse = rawUpload?.get('ai_response_raw') as unknown;
    expect(typeof aiResponse).toBe('string');
    expect((aiResponse as string).length).toBeGreaterThan(0);
  }, 25000);

  it('combines text and an image into a single extraction call (research.md #8)', async () => {
    const { workoutId, rawUploadRef } = await seedWorkoutWithImages('bench press 80kg x8, x8, x6', 1);
    publishUploaded(workoutId, rawUploadRef);

    const status = await waitForStatus(workoutId);
    expect(['parsed', 'needs_review']).toContain(status);

    // The text half of the combined call is unambiguous, so the catalogued
    // bench-press movement should come through.
    const [row] = (await dataSource.query(
      `SELECT e.slug FROM workout_exercises we JOIN exercises e ON e.id = we.exercise_id WHERE we.workout_id = $1`,
      [workoutId],
    )) as Array<{ slug: string }>;
    expect(row?.slug).toBe('bench-press');
  }, 25000);

  it('deletes GridFS images once the workout reaches a terminal status (research.md #11)', async () => {
    const { workoutId, rawUploadRef, imageRefs } = await seedWorkoutWithImages('bench press 80kg x8', 2);
    const bucket = getWorkoutImagesBucket(mongoConnection);

    const beforeFiles = await bucket
      .find({ _id: { $in: imageRefs.map((id) => new mongoConnection.base.mongo.ObjectId(id)) } })
      .toArray();
    expect(beforeFiles).toHaveLength(2);

    publishUploaded(workoutId, rawUploadRef);
    await waitForStatus(workoutId);
    await new Promise((resolve) => setTimeout(resolve, 300)); // cleanup runs after the status update, not before

    const afterFiles = await bucket
      .find({ _id: { $in: imageRefs.map((id) => new mongoConnection.base.mongo.ObjectId(id)) } })
      .toArray();
    expect(afterFiles).toHaveLength(0);
  }, 25000);

  describe('handleParseFailure (T032 retry/DLQ routing — tested directly, not via real multi-minute TTLs)', () => {
    const SCRATCH_QUEUE = 'test.scratch.retry-routing';

    // handleParseFailure calls channel.ack(msg) internally, which requires a real
    // delivery tag — a hand-built ConsumeMessage object doesn't have one, and
    // acking it crashes the whole channel with a 406 (learned the hard way: this
    // took down the rest of the suite the first time). So: deliver a real message
    // for a valid delivery tag. `headers` lets a test seed the x-retry-attempt
    // counter the way a real dead-letter hop would.
    async function deliverScratchMessage(headers?: Record<string, unknown>): Promise<ConsumeMessage> {
      await channel.assertQueue(SCRATCH_QUEUE, { durable: false, autoDelete: true });
      channel.sendToQueue(SCRATCH_QUEUE, Buffer.from('{}'), { persistent: false, headers });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const msg = await channel.get(SCRATCH_QUEUE);
      if (!msg) throw new Error('expected a message on the scratch queue');
      return msg;
    }

    it('routes a first failure into the 5s retry tier', async () => {
      await channel.purgeQueue('workout.parse.q.retry.5s');
      const { workoutId } = await seedWorkout('routing test 1');
      const event = { event_id: randomUUID(), user_id: userId, workout_id: workoutId, raw_upload_ref: 'x', occurred_at: '' };

      await handleParseFailure(context, await deliverScratchMessage(), event, 1);

      await new Promise((resolve) => setTimeout(resolve, 200));
      const msg = await channel.get('workout.parse.q.retry.5s');
      expect(msg).not.toBe(false);
      if (msg) channel.ack(msg);
    });

    it('routes an exhausted (4th) failure to workout.dlq and marks the workout failed', async () => {
      const { workoutId } = await seedWorkout('routing test 2');
      const event = { event_id: randomUUID(), user_id: userId, workout_id: workoutId, raw_upload_ref: 'x', occurred_at: '' };

      await handleParseFailure(context, await deliverScratchMessage(), event, 4);

      await new Promise((resolve) => setTimeout(resolve, 200));
      const dlqMsg = await channel.get(WORKOUT_DLQ);
      expect(dlqMsg).not.toBe(false);
      if (dlqMsg) channel.ack(dlqMsg);

      const [row] = (await dataSource.query('SELECT status FROM workouts WHERE id = $1', [workoutId])) as Array<{
        status: string;
      }>;
      expect(row.status).toBe('failed');
    });

    it('deletes GridFS images once a workout is exhausted to the DLQ (research.md #11)', async () => {
      const { workoutId, rawUploadRef, imageRefs } = await seedWorkoutWithImages('routing test 3', 2);
      const event = {
        event_id: randomUUID(),
        user_id: userId,
        workout_id: workoutId,
        raw_upload_ref: rawUploadRef,
        occurred_at: '',
      };

      await handleParseFailure(context, await deliverScratchMessage(), event, 4);

      await new Promise((resolve) => setTimeout(resolve, 200));
      const dlqMsg = await channel.get(WORKOUT_DLQ);
      if (dlqMsg) channel.ack(dlqMsg);

      const bucket = getWorkoutImagesBucket(mongoConnection);
      const files = await bucket
        .find({ _id: { $in: imageRefs.map((id) => new mongoConnection.base.mongo.ObjectId(id)) } })
        .toArray();
      expect(files).toHaveLength(0);
    });

    it('walks the tiers via the default parameter: x-retry-attempt N drives the (N+1)th tier and is carried forward', async () => {
      // The bug this guards against: handleParseFailure used to re-publish the
      // bare body, so the attempt counter reset every hop and the message looped
      // in workout.parse.q.retry.30s forever, never reaching the DLQ.
      await channel.purgeQueue('workout.parse.q.retry.5m');
      const { workoutId } = await seedWorkout('routing test 4');
      const event = { event_id: randomUUID(), user_id: userId, workout_id: workoutId, raw_upload_ref: 'x', occurred_at: '' };

      const msg = await deliverScratchMessage({ 'x-retry-attempt': 2 });
      expect(getRetryAttempt(msg)).toBe(2);

      await handleParseFailure(context, msg, event); // no explicit attemptNumber → getRetryAttempt(2) + 1 = 3

      await new Promise((resolve) => setTimeout(resolve, 200));
      const routed = await channel.get('workout.parse.q.retry.5m');
      expect(routed).not.toBe(false);
      if (routed) {
        expect(getRetryAttempt(routed)).toBe(3);
        channel.ack(routed);
      }
    });

    it('the x-retry-attempt header survives a real TTL dead-letter hop (unlike x-death)', async () => {
      // RabbitMQ strips its reserved x-death on a client publish, which is why
      // the counter lives in a plain header instead. Scratch queues (not the
      // real workout.parse.q — the live worker would eat the probe).
      const scratchTtl = 'test.scratch.retry-attempt.5s';
      await channel.assertQueue(SCRATCH_QUEUE, { durable: false, autoDelete: true });
      await channel.assertQueue(scratchTtl, {
        durable: false,
        autoDelete: true,
        messageTtl: 5000,
        deadLetterExchange: '',
        deadLetterRoutingKey: SCRATCH_QUEUE,
      });
      channel.sendToQueue(scratchTtl, Buffer.from('{"probe":true}'), {
        persistent: false,
        headers: { 'x-retry-attempt': 1 },
      });

      await new Promise((resolve) => setTimeout(resolve, 5800));
      const back = await channel.get(SCRATCH_QUEUE);
      if (!back) throw new Error('expected the probe back after its 5s TTL');
      expect(getRetryAttempt(back)).toBe(1);
      channel.ack(back);
      await channel.deleteQueue(scratchTtl).catch(() => undefined);
    }, 10000);
  });

  it('a workout whose raw_upload is gone is marked failed immediately, not looped through the retry tiers', async () => {
    await purgeAllWorkoutQueues();
    const { workoutId, rawUploadRef } = await seedWorkout('orphan test');
    await mongoConnection.model('RawUpload').deleteOne({ _id: rawUploadRef });

    publishUploaded(workoutId, rawUploadRef);
    const status = await waitForStatus(workoutId, 8000);
    expect(status).toBe('failed');

    // Nothing left cycling — no retry-tier or DLQ messages for it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const tier of retryTiersFor(WORKOUT_PARSE_QUEUE)) {
      const stuck = await channel.get(tier.queue);
      expect(stuck, `unexpected message in ${tier.queue}`).toBe(false);
      if (stuck) channel.ack(stuck);
    }
  }, 12000);
  },
);
