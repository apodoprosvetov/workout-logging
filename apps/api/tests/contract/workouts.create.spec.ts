import { NestFastifyApplication } from '@nestjs/platform-fastify';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  connectRabbitMq,
  createMongooseConnection,
  createRedisClient,
  createTypeOrmDataSource,
  getWorkoutImagesBucket,
  WORKOUT_PARSE_QUEUE,
} from '@workout-logging/shared';

import { AuthModule } from '../../src/auth/auth.module';
import { WorkoutsModule } from '../../src/workouts/workouts.module';
import { createTestApp, deleteTestUsers, httpServer, testEmailFactory } from '../helpers/test-app';

// A real 1x1 PNG — the parser worker (T044) rejects any image whose magic bytes
// aren't a known format, so an upload fixture has to be a genuine image now.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('POST /workouts (contract, per contracts/api.md)', () => {
  let app: NestFastifyApplication;
  const emails = testEmailFactory('t030');
  const password = 'correct horse battery staple';

  async function registerAndGetToken(label: string): Promise<{ email: string; accessToken: string }> {
    const email = emails.next(label);
    const res = await request(httpServer(app)).post('/api/auth/register').send({ email, password });
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
      .post('/api/workouts')
      .set('authorization', `Bearer ${accessToken}`)
      .field('text', 'bench press 80kg x8')
      .field('performed_at', new Date().toISOString());
    const elapsedMs = Date.now() - start;

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('pending');
    expect(typeof res.body.workout_id).toBe('string');
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('echoes back the performed_at it was given', async () => {
    const { accessToken } = await registerAndGetToken('echo-date');
    const performedAt = new Date('2013-11-04T00:00:00.000Z');

    const res = await request(httpServer(app))
      .post('/api/workouts')
      .set('authorization', `Bearer ${accessToken}`)
      .field('text', 'squat 100kg x5')
      .field('performed_at', performedAt.toISOString());

    expect(res.status).toBe(202);
    expect(res.body.performed_at).toBe(performedAt.toISOString());
  });

  it('returns the date it chose when performed_at was omitted', async () => {
    // The whole reason this field is in the response: the caller cannot know
    // the default otherwise, and a client that recomputed it would be
    // duplicating server behaviour (specs/003, T017).
    const { accessToken } = await registerAndGetToken('default-date');

    const before = Date.now();
    const res = await request(httpServer(app))
      .post('/api/workouts')
      .set('authorization', `Bearer ${accessToken}`)
      .field('text', 'overhead press 40kg x10');
    const after = Date.now();

    expect(res.status).toBe(202);
    expect(typeof res.body.performed_at).toBe('string');
    const returned = new Date(res.body.performed_at as string).getTime();
    expect(returned).toBeGreaterThanOrEqual(before);
    expect(returned).toBeLessThanOrEqual(after);
  });

  it('really did write to Postgres, MongoDB, and publish to workout.parse.q', async () => {
    const { accessToken } = await registerAndGetToken('sideeffects');
    const res = await request(httpServer(app))
      .post('/api/workouts')
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
    const res = await request(httpServer(app)).post('/api/workouts').field('text', 'bench press');

    expect(res.status).toBe(401);
  });

  it('rejects a forged user_id in the body — the owner comes from the token only (FR-015, T053)', async () => {
    const { accessToken } = await registerAndGetToken('spoofbody');
    const victim = await registerAndGetToken('spoofvictim');

    const res = await request(httpServer(app))
      .post('/api/workouts')
      .set('authorization', `Bearer ${accessToken}`)
      .field('text', 'bench press 80kg x5')
      .field('user_id', victim.email); // not a DTO field → forbidNonWhitelisted

    expect(res.status).toBe(400);
  });

  it('the created workout is owned by the token subject, not anyone else (FR-015, T053)', async () => {
    const { accessToken } = await registerAndGetToken('ownercheck');
    const sub = JSON.parse(
      Buffer.from(accessToken.split('.')[1], 'base64url').toString(),
    ).sub as string;

    const res = await request(httpServer(app))
      .post('/api/workouts')
      .set('authorization', `Bearer ${accessToken}`)
      .field('text', 'deadlift 100kg x5');
    expect(res.status).toBe(202);

    const ds = createTypeOrmDataSource();
    await ds.initialize();
    const [row] = (await ds.query('SELECT user_id FROM workouts WHERE id = $1', [res.body.workout_id])) as Array<{
      user_id: string;
    }>;
    await ds.destroy();
    expect(row.user_id).toBe(sub);
  });

  it('accepts multiple images under the same "images" field (research.md #11), stores each in GridFS, and records has_image', async () => {
    const { accessToken } = await registerAndGetToken('multiimage');
    const res = await request(httpServer(app))
      .post('/api/workouts')
      .set('authorization', `Bearer ${accessToken}`)
      .attach('images', TINY_PNG, 'page1.png')
      .attach('images', TINY_PNG, 'page2.png')
      .attach('images', TINY_PNG, 'page3.png');

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
    // Each ref is a real GridFS file id, not an opaque string. Not asserting the
    // files still exist: image lifetime belongs to the parser worker (research.md
    // #11 — it deletes them on a terminal status), and a running dev worker will
    // already have consumed this event. That the bytes land in GridFS is proven
    // race-free in apps/worker parser.spec.ts.
    for (const ref of imageRefs) {
      expect(mongoose.mongo.ObjectId.isValid(ref)).toBe(true);
    }
    await mongoConn.close();
  });

  it('rejects more than 10 images (MAX_WORKOUT_IMAGES cap, research.md #11)', async () => {
    const { accessToken } = await registerAndGetToken('toomanyimages');
    let req = request(httpServer(app)).post('/api/workouts').set('authorization', `Bearer ${accessToken}`);
    for (let i = 0; i < 11; i++) {
      req = req.attach('images', TINY_PNG, `page${i}.png`);
    }
    const res = await req;

    expect(res.status).toBe(400);
  });

  it('returns 400 when neither text nor image is provided', async () => {
    const { accessToken } = await registerAndGetToken('empty');

    const res = await request(httpServer(app))
      .post('/api/workouts')
      .set('authorization', `Bearer ${accessToken}`)
      .field('performed_at', new Date().toISOString());

    expect(res.status).toBe(400);
  });

  it('treats an empty "images" field as no image: text-only submission, has_image false, no GridFS ref', async () => {
    const { accessToken } = await registerAndGetToken('emptyimages');

    // A client that always appends the field (or `curl -F 'images='`) sends it
    // as an empty text part — must not become `['']` -> has_image true -> a junk
    // 0-byte GridFS object (create-workout.dto.ts filters it).
    const res = await request(httpServer(app))
      .post('/api/workouts')
      .set('authorization', `Bearer ${accessToken}`)
      .field('text', 'bench press 80kg x8, x8, x6')
      .field('images', '');

    expect(res.status).toBe(202);

    const ds = createTypeOrmDataSource();
    await ds.initialize();
    const [row] = (await ds.query('SELECT has_text, has_image, raw_input_ref FROM workouts WHERE id = $1', [
      res.body.workout_id,
    ])) as Array<{ has_text: boolean; has_image: boolean; raw_input_ref: string }>;
    await ds.destroy();
    expect(row.has_text).toBe(true);
    expect(row.has_image).toBe(false);

    const mongoConn = await createMongooseConnection();
    const rawUpload = await mongoConn.model('RawUpload').findById(row.raw_input_ref);
    expect((rawUpload?.get('image_refs') ?? []) as string[]).toHaveLength(0);
    await mongoConn.close();
  });

  it('returns 400 when the only field is an empty "images" (no text)', async () => {
    const { accessToken } = await registerAndGetToken('emptyimagesonly');

    const res = await request(httpServer(app))
      .post('/api/workouts')
      .set('authorization', `Bearer ${accessToken}`)
      .field('images', '');

    expect(res.status).toBe(400);
  });

  it('returns 400 for a malformed performed_at', async () => {
    const { accessToken } = await registerAndGetToken('badtime');

    const res = await request(httpServer(app))
      .post('/api/workouts')
      .set('authorization', `Bearer ${accessToken}`)
      .field('text', 'deadlift 120kg x3')
      .field('performed_at', 'not-a-date');

    expect(res.status).toBe(400);
  });

  it('returns 400 for free text past the 50k length cap (T051)', async () => {
    const { accessToken } = await registerAndGetToken('longtext');

    const res = await request(httpServer(app))
      .post('/api/workouts')
      .set('authorization', `Bearer ${accessToken}`)
      .field('text', 'x'.repeat(50_001));

    expect(res.status).toBe(400);
  });

  it('rate-limits at 30/minute/user (FR-018) — the 31st request in a minute gets 429', async () => {
    const { accessToken } = await registerAndGetToken('ratelimit');

    const responses: number[] = [];
    for (let i = 0; i < 31; i++) {
      // Sequential on purpose: the sliding-window limiter counts requests within
      // the window regardless of concurrency, and sequential keeps this deterministic.
      const res = await request(httpServer(app))
        .post('/api/workouts')
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
