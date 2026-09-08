import { randomUUID } from 'node:crypto';

import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

import { AuthModule } from '../../src/auth/auth.module';
import { WorkoutsModule } from '../../src/workouts/workouts.module';
import { createTestApp, deleteTestUsers, httpServer, testEmailFactory } from '../helpers/test-app';

describe('DELETE /workouts/:id (contract, per contracts/api.md)', () => {
  let app: NestFastifyApplication;
  const emails = testEmailFactory('workouts-delete');
  const password = 'correct horse battery staple';
  let accessToken: string;
  let userId: string;
  let otherAccessToken: string;
  let exerciseId: string;

  async function registerAndGetToken(
    label: string,
  ): Promise<{ userId: string; accessToken: string }> {
    const email = emails.next(label);
    const res = await request(httpServer(app)).post('/api/auth/register').send({ email, password });
    const body = res.body as { access_token: string; user: { id: string } };
    return { userId: body.user.id, accessToken: body.access_token };
  }

  // Seeds a workout for `userId` with one exercise and two sets, returns its id.
  async function seedWorkout(ownerId: string): Promise<string> {
    const ds = createTypeOrmDataSource();
    await ds.initialize();
    try {
      const workout = await ds.getRepository(Workout).save(
        ds.getRepository(Workout).create({
          userId: ownerId,
          source: WorkoutSource.WEB,
          hasText: true,
          hasImage: false,
          rawInputRef: 'test-ref',
          status: WorkoutStatus.PARSED,
          performedAt: new Date('2020-06-01T00:00:00.000Z'),
          performedAtExplicit: true,
        }),
      );
      const workoutExercise = await ds
        .getRepository(WorkoutExercise)
        .save(
          ds
            .getRepository(WorkoutExercise)
            .create({ workoutId: workout.id, exerciseId, exerciseOrder: 1 }),
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
      return workout.id;
    } finally {
      await ds.destroy();
    }
  }

  // Rows belonging to one specific workout, plus whether the shared catalog row
  // it referenced still exists.
  async function countRowsFor(
    workoutId: string,
  ): Promise<{ workouts: number; workoutExercises: number; sets: number; exercises: number }> {
    const ds = createTypeOrmDataSource();
    await ds.initialize();
    try {
      const workouts = await ds.getRepository(Workout).countBy({ id: workoutId });
      const workoutExercises = await ds.getRepository(WorkoutExercise).countBy({ workoutId });
      const sets = await ds
        .getRepository(WorkoutSet)
        .createQueryBuilder('s')
        .innerJoin('s.workoutExercise', 'we')
        .where('we.workoutId = :workoutId', { workoutId })
        .getCount();
      const exercises = await ds.getRepository(Exercise).countBy({ id: exerciseId });
      return { workouts, workoutExercises, sets, exercises };
    } finally {
      await ds.destroy();
    }
  }

  beforeAll(async () => {
    app = await createTestApp([AuthModule, WorkoutsModule]);
    const mine = await registerAndGetToken('mine');
    userId = mine.userId;
    accessToken = mine.accessToken;
    otherAccessToken = (await registerAndGetToken('other')).accessToken;

    const ds = createTypeOrmDataSource();
    await ds.initialize();
    const exerciseRepository = ds.getRepository(Exercise);
    const exercise =
      (await exerciseRepository.findOneBy({ slug: 'bench-press' })) ??
      (await exerciseRepository.save(
        exerciseRepository.create({ slug: 'bench-press', name: 'Bench Press' }),
      ));
    exerciseId = exercise.id;
    await ds.destroy();
  });

  afterAll(async () => {
    const ds = createTypeOrmDataSource();
    await ds.initialize();
    const users = (await ds.query('SELECT id FROM users WHERE email = ANY($1)', [
      emails.all(),
    ])) as Array<{
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
    const res = await request(httpServer(app)).delete(`/api/workouts/${randomUUID()}`);
    expect(res.status).toBe(401);
  });

  it('returns 400 for a malformed id', async () => {
    const res = await request(httpServer(app))
      .delete('/api/workouts/not-a-uuid')
      .set('authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(400);
  });

  it('returns 404 for a nonexistent (but validly formatted) id', async () => {
    const res = await request(httpServer(app))
      .delete(`/api/workouts/${randomUUID()}`)
      .set('authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(404);
  });

  it("returns 404, not 403, for another user's workout and leaves it in place", async () => {
    const workoutId = await seedWorkout(userId);
    const res = await request(httpServer(app))
      .delete(`/api/workouts/${workoutId}`)
      .set('authorization', `Bearer ${otherAccessToken}`);
    expect(res.status).toBe(404);
    expect(await countRowsFor(workoutId)).toEqual({
      workouts: 1,
      workoutExercises: 1,
      sets: 2,
      exercises: 1,
    });
  });

  it('returns 204 and cascade-removes the workout, its exercises and sets (catalog untouched)', async () => {
    const workoutId = await seedWorkout(userId);
    expect(await countRowsFor(workoutId)).toEqual({
      workouts: 1,
      workoutExercises: 1,
      sets: 2,
      exercises: 1,
    });

    const res = await request(httpServer(app))
      .delete(`/api/workouts/${workoutId}`)
      .set('authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(204);
    expect(await countRowsFor(workoutId)).toEqual({
      workouts: 0,
      workoutExercises: 0,
      sets: 0,
      exercises: 1,
    });
  });
});
