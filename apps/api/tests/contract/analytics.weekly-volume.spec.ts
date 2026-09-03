import { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  createRedisClient,
  createTypeOrmDataSource,
  isoWeekKey,
  isoWeekToDate,
  seedExerciseCatalog,
  weeklyVolumeRedisKey,
  Exercise,
  SetUnit,
  Workout,
  WorkoutExercise,
  WorkoutSet,
  WorkoutSource,
  WorkoutStatus,
} from '@workout-logging/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnalyticsModule } from '../../src/analytics/analytics.module';
import { AuthModule } from '../../src/auth/auth.module';
import { createTestApp, deleteTestUsers, httpServer, testEmailFactory } from '../helpers/test-app';

interface Volume {
  muscle_group: string;
  volume: number;
}

describe('GET /analytics/weekly-volume (contract, per contracts/api.md)', () => {
  let app: NestFastifyApplication;
  const emails = testEmailFactory('analytics-weekly');
  const password = 'correct horse battery staple';
  let accessToken: string;
  let userId: string;
  let otherAccessToken: string;

  // A fixed past week so the seeded data is deterministic and never collides
  // with "current week" assertions.
  const week = isoWeekKey(new Date('2025-03-12T00:00:00.000Z')); // 2025-W11

  async function registerAndGetToken(label: string): Promise<{ userId: string; accessToken: string }> {
    const email = emails.next(label);
    const res = await request(httpServer(app)).post('/api/auth/register').send({ email, password });
    const body = res.body as { access_token: string; user: { id: string } };
    return { userId: body.user.id, accessToken: body.access_token };
  }

  async function seedWorkout(
    ownerId: string,
    isoWeek: string,
    status: WorkoutStatus,
    exercises: Array<{ slug: string; sets: Array<{ weight: number; reps: number }> }>,
  ): Promise<void> {
    const ds = createTypeOrmDataSource();
    await ds.initialize();
    try {
      const performedAt = new Date(isoWeekToDate(isoWeek).getTime() + 2 * 86_400_000); // Wed of that week
      const workout = await ds.getRepository(Workout).save(
        ds.getRepository(Workout).create({
          userId: ownerId,
          source: WorkoutSource.WEB,
          hasText: true,
          hasImage: false,
          rawInputRef: 'analytics-test',
          status,
          performedAt,
          performedAtExplicit: true,
        }),
      );
      let order = 0;
      for (const ex of exercises) {
        order += 1;
        const exercise =
          (await ds.getRepository(Exercise).findOneBy({ slug: ex.slug })) ??
          (await ds.getRepository(Exercise).save(ds.getRepository(Exercise).create({ slug: ex.slug, name: ex.slug })));
        const we = await ds.getRepository(WorkoutExercise).save(
          ds.getRepository(WorkoutExercise).create({ workoutId: workout.id, exerciseId: exercise.id, exerciseOrder: order }),
        );
        let setOrder = 0;
        for (const s of ex.sets) {
          setOrder += 1;
          await ds.getRepository(WorkoutSet).save(
            ds.getRepository(WorkoutSet).create({
              workoutExerciseId: we.id,
              setOrder,
              weight: String(s.weight),
              reps: s.reps,
              unit: SetUnit.KG,
            }),
          );
        }
      }
    } finally {
      await ds.destroy();
    }
  }

  beforeAll(async () => {
    await seedExerciseCatalog();
    app = await createTestApp([AuthModule, AnalyticsModule]);
    const mine = await registerAndGetToken('mine');
    userId = mine.userId;
    accessToken = mine.accessToken;
    otherAccessToken = (await registerAndGetToken('other')).accessToken;
  });

  afterAll(async () => {
    const ds = createTypeOrmDataSource();
    await ds.initialize();
    const users = (await ds.query('SELECT id FROM users WHERE email = ANY($1)', [emails.all()])) as Array<{ id: string }>;
    const userIds = users.map((u) => u.id);
    if (userIds.length > 0) {
      await ds.query(
        `DELETE FROM sets WHERE workout_exercise_id IN
           (SELECT id FROM workout_exercises WHERE workout_id IN (SELECT id FROM workouts WHERE user_id = ANY($1)))`,
        [userIds],
      );
      await ds.query(
        'DELETE FROM workout_exercises WHERE workout_id IN (SELECT id FROM workouts WHERE user_id = ANY($1))',
        [userIds],
      );
      await ds.query('DELETE FROM workouts WHERE user_id = ANY($1)', [userIds]);
    }
    await ds.destroy();

    const redis = createRedisClient();
    for (const id of userIds) await redis.del(weeklyVolumeRedisKey(id, week));
    redis.quit();

    await deleteTestUsers(emails.all());
    await app.close();
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await request(httpServer(app)).get('/api/analytics/weekly-volume');
    expect(res.status).toBe(401);
  });

  it('returns 400 for a malformed week', async () => {
    const res = await request(httpServer(app))
      .get('/api/analytics/weekly-volume?week=not-a-week')
      .set('authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(400);
  });

  it('defaults to the current ISO week and returns an empty list when there is nothing', async () => {
    const res = await request(httpServer(app))
      .get('/api/analytics/weekly-volume')
      .set('authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.week).toBe(isoWeekKey(new Date()));
    expect(res.body.volumes).toEqual([]);
  });

  it('falls back to a Postgres computation on cache miss, aggregating by muscle group and sorted desc', async () => {
    // bench-press -> chest/triceps/shoulders ; squat -> quads/glutes/hamstrings/core
    await seedWorkout(userId, week, WorkoutStatus.PARSED, [
      { slug: 'bench-press', sets: [{ weight: 100, reps: 5 }, { weight: 100, reps: 5 }] }, // 1000
    ]);
    await seedWorkout(userId, week, WorkoutStatus.NEEDS_REVIEW, [
      { slug: 'squat', sets: [{ weight: 140, reps: 5 }] }, // 700
    ]);

    const res = await request(httpServer(app))
      .get(`/api/analytics/weekly-volume?week=${week}`)
      .set('authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.week).toBe(week);

    const byGroup = Object.fromEntries((res.body.volumes as Volume[]).map((v) => [v.muscle_group, v.volume]));
    expect(byGroup.chest).toBe(1000);
    expect(byGroup.triceps).toBe(1000);
    expect(byGroup.shoulders).toBe(1000);
    expect(byGroup.quads).toBe(700);
    expect(byGroup.core).toBe(700);

    const volumes = res.body.volumes as Volume[];
    expect(volumes.map((v) => v.volume)).toEqual([...volumes.map((v) => v.volume)].sort((a, b) => b - a));
  });

  it('reads the Redis hash when present, not Postgres', async () => {
    const redis = createRedisClient();
    await redis.del(weeklyVolumeRedisKey(userId, week));
    await redis.hset(weeklyVolumeRedisKey(userId, week), { chest: '42', back: '17' });

    const res = await request(httpServer(app))
      .get(`/api/analytics/weekly-volume?week=${week}`)
      .set('authorization', `Bearer ${accessToken}`);
    redis.quit();

    expect(res.status).toBe(200);
    expect(res.body.volumes).toEqual([
      { muscle_group: 'chest', volume: 42 },
      { muscle_group: 'back', volume: 17 },
    ]);
  });

  it('is scoped to the caller — another user does not see this user\'s volume', async () => {
    // `userId` has seeded workouts in `week` (test above); the `other` user has
    // none. A cross-user read must come back empty, not leak `userId`'s data.
    const res = await request(httpServer(app))
      .get(`/api/analytics/weekly-volume?week=${week}`)
      .set('authorization', `Bearer ${otherAccessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.volumes).toEqual([]);
  });
});
