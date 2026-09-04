import { randomUUID } from 'node:crypto';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  createTypeOrmDataSource,
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
import { AuthModule } from '../../src/auth/auth.module';
import { WorkoutsModule } from '../../src/workouts/workouts.module';
import { createTestApp, deleteTestUsers, httpServer, testEmailFactory } from '../helpers/test-app';

describe('GET /workouts/:id (contract, per contracts/api.md)', () => {
  let app: NestFastifyApplication;
  const emails = testEmailFactory('t034');
  const password = 'correct horse battery staple';
  let accessToken: string;
  let userId: string;
  let otherUserId: string;
  let workoutId: string;
  let otherUsersWorkoutId: string;

  async function registerAndGetToken(label: string): Promise<{ userId: string; accessToken: string }> {
    const email = emails.next(label);
    const res = await request(httpServer(app)).post('/api/auth/register').send({ email, password });
    const body = res.body as { access_token: string; user: { id: string } };
    return { userId: body.user.id, accessToken: body.access_token };
  }

  beforeAll(async () => {
    app = await createTestApp([AuthModule, WorkoutsModule]);
    const mine = await registerAndGetToken('mine');
    userId = mine.userId;
    accessToken = mine.accessToken;
    otherUserId = (await registerAndGetToken('other')).userId;

    const ds = createTypeOrmDataSource();
    await ds.initialize();

    // findOneByOrFail used to assume this row already existed — true only
    // by accident in local dev (a prior real parser run had upserted it via
    // matchAndUpsertExercise), never true on a fresh database (e.g. CI).
    // Postgres `exercises` rows aren't seeded like Mongo's exercise_catalog
    // (packages/shared/src/db/seed-exercise-catalog.ts) — they're normally
    // created lazily by the worker, so the test creates its own fixture
    // instead of relying on incidental prior state. The row is shared with
    // other contract specs and never cleaned up, so force the canonical
    // name — a spec that ran first may have created it as the bare slug.
    const exerciseRepository = ds.getRepository(Exercise);
    let exercise = await exerciseRepository.findOneBy({ slug: 'bench-press' });
    if (!exercise) {
      exercise = await exerciseRepository.save(
        exerciseRepository.create({ slug: 'bench-press', name: 'Bench Press' }),
      );
    } else if (exercise.name !== 'Bench Press') {
      await exerciseRepository.update({ id: exercise.id }, { name: 'Bench Press' });
    }

    const workout = await ds.getRepository(Workout).save(
      ds.getRepository(Workout).create({
        userId,
        source: WorkoutSource.WEB,
        hasText: true,
        hasImage: false,
        rawInputRef: 'test-ref',
        status: WorkoutStatus.PARSED,
        performedAt: new Date('2020-06-01T00:00:00.000Z'),
        performedAtExplicit: true,
        name: 'Push day',
      }),
    );
    workoutId = workout.id;

    const workoutExercise = await ds.getRepository(WorkoutExercise).save(
      ds.getRepository(WorkoutExercise).create({ workoutId, exerciseId: exercise.id, exerciseOrder: 1 }),
    );
    await ds.getRepository(WorkoutSet).save([
      ds.getRepository(WorkoutSet).create({
        workoutExerciseId: workoutExercise.id,
        setOrder: 1,
        weight: '80',
        reps: 8,
        unit: SetUnit.KG,
      }),
      ds.getRepository(WorkoutSet).create({
        workoutExerciseId: workoutExercise.id,
        setOrder: 2,
        weight: '80',
        reps: 6,
        unit: SetUnit.KG,
      }),
    ]);

    const otherWorkout = await ds.getRepository(Workout).save(
      ds.getRepository(Workout).create({
        userId: otherUserId,
        source: WorkoutSource.WEB,
        hasText: true,
        hasImage: false,
        rawInputRef: 'test-ref',
        status: WorkoutStatus.PARSED,
        performedAt: new Date(),
        performedAtExplicit: false,
      }),
    );
    otherUsersWorkoutId = otherWorkout.id;

    await ds.destroy();
  });

  afterAll(async () => {
    const ds = createTypeOrmDataSource();
    await ds.initialize();
    const users = (await ds.query('SELECT id FROM users WHERE email = ANY($1)', [emails.all()])) as Array<{
      id: string;
    }>;
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
    await deleteTestUsers(emails.all());
    await app.close();
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await request(httpServer(app)).get(`/api/workouts/${workoutId}`);
    expect(res.status).toBe(401);
  });

  it('returns the full workout with ordered exercises/sets for its owner', async () => {
    const res = await request(httpServer(app)).get(`/api/workouts/${workoutId}`).set('authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: workoutId,
      name: 'Push day',
      status: 'parsed',
      source: 'web',
      performed_at: '2020-06-01T00:00:00.000Z',
    });
    expect(res.body.exercises).toHaveLength(1);
    expect(res.body.exercises[0]).toMatchObject({ name: 'Bench Press', order: 1 });
    expect(res.body.exercises[0].sets).toEqual([
      { order: 1, weight: 80, reps: 8, unit: 'kg' },
      { order: 2, weight: 80, reps: 6, unit: 'kg' },
    ]);
  });

  it("returns 404, not 403, for another user's workout (never confirm existence)", async () => {
    const res = await request(httpServer(app))
      .get(`/api/workouts/${otherUsersWorkoutId}`)
      .set('authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a nonexistent (but validly formatted) id', async () => {
    const res = await request(httpServer(app)).get(`/api/workouts/${randomUUID()}`).set('authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(404);
  });

  it('returns 400 for a malformed id', async () => {
    const res = await request(httpServer(app)).get('/api/workouts/not-a-uuid').set('authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(400);
  });
});
