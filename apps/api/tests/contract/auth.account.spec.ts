import { NestFastifyApplication } from '@nestjs/platform-fastify';
import mongoose, { type Connection, type Model } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createMongooseConnection,
  createRedisClient,
  createTypeOrmDataSource,
  getWorkoutImagesBucket,
  ingestRateLimitKey,
  isoWeekKey,
  RawUploadDocument,
  uploadWorkoutImage,
  weeklyVolumeRedisKey,
  Exercise,
  SetUnit,
  Workout,
  WorkoutExercise,
  WorkoutSet,
  WorkoutSource,
  WorkoutStatus,
} from '@workout-logging/shared';

import { AuthModule } from '../../src/auth/auth.module';
import { createTestApp, httpServer, testEmailFactory } from '../helpers/test-app';

import type { Redis } from 'ioredis';

// A real 1x1 PNG (same fixture the parser/ingestion suites use).
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const WEEK = isoWeekKey(new Date('2025-03-12T00:00:00.000Z')); // 2025-W11

interface SeededAccount {
  userId: string;
  accessToken: string;
  workoutId: string;
  rawUploadId: string;
  imageRef: string;
}

describe('DELETE /auth/account (contract, per contracts/api.md + data-model.md Account Deletion)', () => {
  let app: NestFastifyApplication;
  const emails = testEmailFactory('auth-account');
  const password = 'correct horse battery staple';

  let mongo: Connection;
  let rawUploadModel: Model<RawUploadDocument>;
  let redis: Redis;
  let exerciseId: string;

  let mine: SeededAccount;
  let other: SeededAccount;

  async function register(label: string): Promise<{ userId: string; accessToken: string }> {
    const email = emails.next(label);
    const res = await request(httpServer(app)).post('/api/auth/register').send({ email, password });
    const body = res.body as { access_token: string; user: { id: string } };
    return { userId: body.user.id, accessToken: body.access_token };
  }

  // One workout (1 exercise, 2 sets) + one raw_upload carrying a real GridFS
  // image + the caller's rate-limit and weekly-volume Redis keys.
  async function seedAccount(label: string): Promise<SeededAccount> {
    const { userId, accessToken } = await register(label);

    const imageRef = await uploadWorkoutImage(
      getWorkoutImagesBucket(mongo),
      TINY_PNG,
      `${label}.png`,
    );
    const rawUpload = await rawUploadModel.create({
      user_id: userId,
      text: 'bench press 80kg x8 x6',
      image_refs: [imageRef],
      ai_response_raw: null,
    });

    const ds = createTypeOrmDataSource();
    await ds.initialize();
    let workoutId: string;
    try {
      const workout = await ds.getRepository(Workout).save(
        ds.getRepository(Workout).create({
          userId,
          source: WorkoutSource.WEB,
          hasText: true,
          hasImage: true,
          rawInputRef: rawUpload._id.toString(),
          status: WorkoutStatus.PARSED,
          performedAt: new Date('2025-03-12T10:00:00.000Z'),
          performedAtExplicit: true,
        }),
      );
      workoutId = workout.id;
      const we = await ds
        .getRepository(WorkoutExercise)
        .save(
          ds
            .getRepository(WorkoutExercise)
            .create({ workoutId: workout.id, exerciseId, exerciseOrder: 1 }),
        );
      await ds.getRepository(WorkoutSet).save([
        ds.getRepository(WorkoutSet).create({
          workoutExerciseId: we.id,
          setOrder: 1,
          weight: '80',
          reps: 8,
          unit: SetUnit.KG,
        }),
        ds.getRepository(WorkoutSet).create({
          workoutExerciseId: we.id,
          setOrder: 2,
          weight: '80',
          reps: 6,
          unit: SetUnit.KG,
        }),
      ]);
    } finally {
      await ds.destroy();
    }

    await redis.set(ingestRateLimitKey(userId), '1');
    await redis.hset(weeklyVolumeRedisKey(userId, WEEK), 'chest', '1280');

    return { userId, accessToken, workoutId, rawUploadId: rawUpload._id.toString(), imageRef };
  }

  async function pgCounts(userId: string): Promise<{
    users: number;
    refreshTokens: number;
    workouts: number;
    workoutExercises: number;
    sets: number;
  }> {
    const ds = createTypeOrmDataSource();
    await ds.initialize();
    try {
      const one = async (sql: string): Promise<number> =>
        Number(((await ds.query(sql, [userId])) as Array<{ n: string }>)[0].n);
      return {
        users: await one('SELECT count(*) n FROM users WHERE id = $1'),
        refreshTokens: await one('SELECT count(*) n FROM refresh_tokens WHERE user_id = $1'),
        workouts: await one('SELECT count(*) n FROM workouts WHERE user_id = $1'),
        workoutExercises: await one(
          'SELECT count(*) n FROM workout_exercises we JOIN workouts w ON w.id = we.workout_id WHERE w.user_id = $1',
        ),
        sets: await one(
          `SELECT count(*) n FROM sets s
             JOIN workout_exercises we ON we.id = s.workout_exercise_id
             JOIN workouts w ON w.id = we.workout_id WHERE w.user_id = $1`,
        ),
      };
    } finally {
      await ds.destroy();
    }
  }

  async function imageExists(ref: string): Promise<boolean> {
    const files = await getWorkoutImagesBucket(mongo)
      .find({ _id: new mongoose.Types.ObjectId(ref) })
      .toArray();
    return files.length > 0;
  }

  beforeAll(async () => {
    mongo = await createMongooseConnection();
    rawUploadModel = mongo.model<RawUploadDocument>('RawUpload');
    redis = createRedisClient();

    const ds = createTypeOrmDataSource();
    await ds.initialize();
    const repo = ds.getRepository(Exercise);
    exerciseId = (
      (await repo.findOneBy({ slug: 'bench-press' })) ??
      (await repo.save(repo.create({ slug: 'bench-press', name: 'Bench Press' })))
    ).id;
    await ds.destroy();

    app = await createTestApp([AuthModule]);
    mine = await seedAccount('mine');
    other = await seedAccount('other');
  });

  afterAll(async () => {
    // Belt-and-braces: the "deletes everything" test should have cleared `mine`;
    // this cleans up `other` and anything a failing test left behind.
    const ds = createTypeOrmDataSource();
    await ds.initialize();
    const users = (await ds.query('SELECT id FROM users WHERE email = ANY($1)', [
      emails.all(),
    ])) as Array<{ id: string }>;
    const ids = users.map((u) => u.id);
    if (ids.length > 0) {
      await ds.query(
        `DELETE FROM sets WHERE workout_exercise_id IN
           (SELECT id FROM workout_exercises WHERE workout_id IN (SELECT id FROM workouts WHERE user_id = ANY($1)))`,
        [ids],
      );
      await ds.query(
        'DELETE FROM workout_exercises WHERE workout_id IN (SELECT id FROM workouts WHERE user_id = ANY($1))',
        [ids],
      );
      await ds.query('DELETE FROM workouts WHERE user_id = ANY($1)', [ids]);
      await ds.query('DELETE FROM refresh_tokens WHERE user_id = ANY($1)', [ids]);
      await ds.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
    }
    await ds.destroy();

    for (const acct of [mine, other]) {
      await rawUploadModel.deleteMany({ user_id: acct.userId });
      await redis.del(ingestRateLimitKey(acct.userId), weeklyVolumeRedisKey(acct.userId, WEEK));
      try {
        await getWorkoutImagesBucket(mongo).delete(new mongoose.Types.ObjectId(acct.imageRef));
      } catch {
        /* already gone */
      }
    }
    await mongo.close();
    redis.disconnect();
    await app.close();
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await request(httpServer(app)).delete('/api/auth/account');
    expect(res.status).toBe(401);
  });

  it('returns 401 with a malformed token', async () => {
    const res = await request(httpServer(app))
      .delete('/api/auth/account')
      .set('authorization', 'Bearer not.a.jwt');
    expect(res.status).toBe(401);
  });

  it('204s and erases the account across Postgres, MongoDB and Redis (FR-021)', async () => {
    expect(await pgCounts(mine.userId)).toEqual({
      users: 1,
      refreshTokens: 1,
      workouts: 1,
      workoutExercises: 1,
      sets: 2,
    });
    expect(await imageExists(mine.imageRef)).toBe(true);

    const res = await request(httpServer(app))
      .delete('/api/auth/account')
      .set('authorization', `Bearer ${mine.accessToken}`);
    expect(res.status).toBe(204);

    expect(await pgCounts(mine.userId)).toEqual({
      users: 0,
      refreshTokens: 0,
      workouts: 0,
      workoutExercises: 0,
      sets: 0,
    });
    expect(await rawUploadModel.countDocuments({ user_id: mine.userId })).toBe(0);
    expect(await imageExists(mine.imageRef)).toBe(false);
    expect(await redis.exists(ingestRateLimitKey(mine.userId))).toBe(0);
    expect(await redis.exists(weeklyVolumeRedisKey(mine.userId, WEEK))).toBe(0);
  });

  it('leaves the shared exercise catalog untouched', async () => {
    const ds = createTypeOrmDataSource();
    await ds.initialize();
    const stillThere = await ds.getRepository(Exercise).countBy({ id: exerciseId });
    await ds.destroy();
    expect(stillThere).toBe(1);
  });

  it('is idempotent — a second delete with the same (now stale) token still 204s', async () => {
    const res = await request(httpServer(app))
      .delete('/api/auth/account')
      .set('authorization', `Bearer ${mine.accessToken}`);
    expect(res.status).toBe(204);
  });

  it("does not touch another user's data", async () => {
    expect(await pgCounts(other.userId)).toEqual({
      users: 1,
      refreshTokens: 1,
      workouts: 1,
      workoutExercises: 1,
      sets: 2,
    });
    expect(await rawUploadModel.countDocuments({ user_id: other.userId })).toBe(1);
    expect(await imageExists(other.imageRef)).toBe(true);
    expect(await redis.exists(weeklyVolumeRedisKey(other.userId, WEEK))).toBe(1);
  });

  it('a deleted user can no longer log in', async () => {
    const res = await request(httpServer(app))
      .post('/api/auth/login')
      .send({ email: emails.all().find((e) => e.includes('-mine-')), password });
    expect(res.status).toBe(401);
  });
});
