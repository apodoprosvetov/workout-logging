import { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  connectRabbitMq,
  createMongooseConnection,
  createRedisClient,
  createTypeOrmDataSource,
  getWorkoutImagesBucket,
  WORKOUT_PARSE_QUEUE,
} from '@workout-logging/shared';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthModule } from '../../src/auth/auth.module';
import { WorkoutsModule } from '../../src/workouts/workouts.module';
import { createTestApp, deleteTestUsers, httpServer, testEmailFactory } from '../helpers/test-app';

describe('POST /workouts (contract, per contracts/api.md)', () => {
  let app: NestFastifyApplication;
  const emails = testEmailFactory('t030');
  const password = 'correct horse battery staple';

  async function registerAndGetToken(label: string): Promise<{ email: string; accessToken: string }> {
    const email = emails.next(label);
    const res = await request(httpServer(app)).post('/auth/register').send({ email, password });
    return { email, accessToken: (res.body as { access_token: string }).access_token };
  }

  beforeAll(async () => {
    app = await createTestApp([AuthModule, WorkoutsModule]);
  });

  afterAll(async () => {
    const ds = createTypeOrmDataSource();
    await ds.initialize();
    const users = (await ds.query('SELECT id FROM users WHERE email = ANY($1)', [emails.all()])) as Array<{
      id: string;
    }>;
    const userIds = users.map((u) => u.id);
    if (userIds.length > 0) {
      await ds.query('DELETE FROM workouts WHERE user_id = ANY($1)', [userIds]);
    }
    await ds.destroy();

    if (userIds.length > 0) {
      const mongoConn = await createMongooseConnection();
      const rawUploads = await mongoConn.model('RawUpload').find({ user_id: { $in: userIds } });
      const bucket = getWorkoutImagesBucket(mongoConn);
      for (const doc of rawUploads) {
        const imageRefs = (doc.get('image_refs') ?? []) as string[];
        await Promise.all(imageRefs.map((id) => bucket.delete(new mongoose.mongo.ObjectId(id)).catch(() => undefined)));
      }
      await mongoConn.model('RawUpload').deleteMany({ user_id: { $in: userIds } });
      await mongoConn.close();

      const redis = createRedisClient();
      await redis.del(...userIds.map((id) => `ratelimit:ingest:${id}`));
      await redis.quit();
    }

    await deleteTestUsers(emails.all());

    // No consumer exists yet (T031), so every workout.uploaded published here just
    // sits in the queue — purge it so the suite leaves shared dev infra as it found it.
    const amqpConnection = await connectRabbitMq();
    const amqpChannel = await amqpConnection.createChannel();
    await amqpChannel.purgeQueue(WORKOUT_PARSE_QUEUE);
    await amqpChannel.close();
    await amqpConnection.close();

    await app.close();
  });

  it('returns 202 with workout_id + status, and acks well under the 2s budget (FR-009/SC-002)', async () => {
    const { accessToken } = await registerAndGetToken('ok');

    const start = Date.now();
    const res = await request(httpServer(app))
      .post('/workouts')
      .set('authorization', `Bearer ${accessToken}`)
      .field('text', 'bench press 80kg x8')
      .field('performed_at', new Date().toISOString());
    const elapsedMs = Date.now() - start;

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('pending');
    expect(typeof res.body.workout_id).toBe('string');
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('really did write to Postgres, MongoDB, and publish to workout.parse.q', async () => {
    const { accessToken } = await registerAndGetToken('sideeffects');
    const res = await request(httpServer(app))
      .post('/workouts')
      .set('authorization', `Bearer ${accessToken}`)
      .field('text', 'squat 100kg x5');

    const ds = createTypeOrmDataSource();
    await ds.initialize();
    const [row] = (await ds.query('SELECT * FROM workouts WHERE id = $1', [res.body.workout_id])) as Array<
      Record<string, unknown>
    >;
    await ds.destroy();
    expect(row.has_text).toBe(true);
    expect(row.status).toBe('pending');

    const mongoConn = await createMongooseConnection();
    const rawUpload = await mongoConn.model('RawUpload').findById(row.raw_input_ref as string);
    await mongoConn.close();
    expect(rawUpload?.get('text')).toBe('squat 100kg x5');
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await request(httpServer(app)).post('/workouts').field('text', 'bench press');

    expect(res.status).toBe(401);
  });

  it('accepts multiple images under the same "images" field (research.md #11), stores each in GridFS, and records has_image', async () => {
    const { accessToken } = await registerAndGetToken('multiimage');
    const res = await request(httpServer(app))
      .post('/workouts')
      .set('authorization', `Bearer ${accessToken}`)
      .attach('images', Buffer.from('fake-image-bytes-1'), 'page1.jpg')
      .attach('images', Buffer.from('fake-image-bytes-2'), 'page2.jpg')
      .attach('images', Buffer.from('fake-image-bytes-3'), 'page3.jpg');

    expect(res.status).toBe(202);

    const ds = createTypeOrmDataSource();
    await ds.initialize();
    const [row] = (await ds.query('SELECT has_text, has_image, raw_input_ref FROM workouts WHERE id = $1', [
      res.body.workout_id,
    ])) as Array<{ has_text: boolean; has_image: boolean; raw_input_ref: string }>;
    await ds.destroy();
    expect(row.has_text).toBe(false);
    expect(row.has_image).toBe(true);

    const mongoConn = await createMongooseConnection();
    const rawUpload = await mongoConn.model('RawUpload').findById(row.raw_input_ref);
    const imageRefs = (rawUpload?.get('image_refs') ?? []) as string[];
    expect(imageRefs).toHaveLength(3);

    // Prove they're real GridFS files, not just opaque strings written to the doc.
    const bucket = getWorkoutImagesBucket(mongoConn);
    const files = await bucket.find({ _id: { $in: imageRefs.map((id) => new mongoose.mongo.ObjectId(id)) } }).toArray();
    expect(files).toHaveLength(3);
    await mongoConn.close();
  });

  it('rejects more than 10 images (MAX_WORKOUT_IMAGES cap, research.md #11)', async () => {
    const { accessToken } = await registerAndGetToken('toomanyimages');
    let req = request(httpServer(app)).post('/workouts').set('authorization', `Bearer ${accessToken}`);
    for (let i = 0; i < 11; i++) {
      req = req.attach('images', Buffer.from(`fake-image-bytes-${i}`), `page${i}.jpg`);
    }
    const res = await req;

    expect(res.status).toBe(400);
  });

  it('returns 400 when neither text nor image is provided', async () => {
    const { accessToken } = await registerAndGetToken('empty');

    const res = await request(httpServer(app))
      .post('/workouts')
      .set('authorization', `Bearer ${accessToken}`)
      .field('performed_at', new Date().toISOString());

    expect(res.status).toBe(400);
  });

  it('returns 400 for a malformed performed_at', async () => {
    const { accessToken } = await registerAndGetToken('badtime');

    const res = await request(httpServer(app))
      .post('/workouts')
      .set('authorization', `Bearer ${accessToken}`)
      .field('text', 'deadlift 120kg x3')
      .field('performed_at', 'not-a-date');

    expect(res.status).toBe(400);
  });

  it('rate-limits at 30/minute/user (FR-018) — the 31st request in a minute gets 429', async () => {
    const { accessToken } = await registerAndGetToken('ratelimit');

    const responses: number[] = [];
    for (let i = 0; i < 31; i++) {
      // Sequential on purpose: the sliding-window limiter counts requests within
      // the window regardless of concurrency, and sequential keeps this deterministic.
      const res = await request(httpServer(app))
        .post('/workouts')
        .set('authorization', `Bearer ${accessToken}`)
        .field('text', `rep ${i}`);
      responses.push(res.status);
    }

    const accepted = responses.filter((s) => s === 202).length;
    const limited = responses.filter((s) => s === 429).length;
    expect(accepted).toBe(30);
    expect(limited).toBe(1);
    expect(responses[30]).toBe(429);
  });
});
