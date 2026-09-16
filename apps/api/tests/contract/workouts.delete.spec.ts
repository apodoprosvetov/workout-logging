import { randomUUID } from 'node:crypto';

import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  connectRabbitMq,
  createTypeOrmDataSource,
  Exercise,
  SetUnit,
  Workout,
  WorkoutExercise,
  WorkoutSet,
  WorkoutSource,
  WorkoutStatus,
  WORKOUT_DELETED_KEY,
  WORKOUT_DELETED_ROUTING_KEY,
  WORKOUT_EVENTS_EXCHANGE,
} from '@workout-logging/shared';

import { AuthModule } from '../../src/auth/auth.module';
import { REDIS_CLIENT } from '../../src/redis/redis.module';
import { WorkoutsModule } from '../../src/workouts/workouts.module';
import { NotificationListener } from '../helpers/notifications';
import { createTestApp, deleteTestUsers, httpServer, testEmailFactory } from '../helpers/test-app';

import type Redis from 'ioredis';

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

  it('publishes workout.deleted carrying the week the workout belonged to', async () => {
    // Nothing else invalidates the weekly-volume cache: the analytics worker only
    // recomputes on an event, so without this the dashboard keeps reporting a
    // deleted workout's volume for up to the cache TTL (120 days).
    //
    // Read from our own exclusive queue bound to the same routing key, not from
    // workout.analytics.q — a dev worker consuming that queue would win the race
    // and this test would fail on any machine running `npm run dev`.
    const conn = await connectRabbitMq();
    const channel = await conn.createChannel();
    const { queue: probe } = await channel.assertQueue('', { exclusive: true });
    await channel.bindQueue(probe, WORKOUT_EVENTS_EXCHANGE, WORKOUT_DELETED_ROUTING_KEY);

    try {
      const workoutId = await seedWorkout(userId);
      const performedAt = (
        await request(httpServer(app))
          .get(`/api/workouts/${workoutId}`)
          .set('authorization', `Bearer ${accessToken}`)
      ).body.performed_at as string;

      const res = await request(httpServer(app))
        .delete(`/api/workouts/${workoutId}`)
        .set('authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(204);

      // The publish is fire-and-forget from the request's perspective — give the
      // broker a beat to route it, as ingestion.service.spec.ts does.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const msg = await channel.get(probe);
      if (!msg) throw new Error('expected a workout.deleted event');
      const event = JSON.parse(msg.content.toString()) as Record<string, unknown>;

      // `type` is what the consumer discriminates on — see the note on
      // WorkoutDeletedEvent. It must be in the body, because the routing key is
      // rewritten to workout.parsed if the message ever goes through a retry.
      expect(event.type).toBe('workout.deleted');
      expect(event.workout_id).toBe(workoutId);
      expect(event.user_id).toBe(userId);
      // The whole point: the consumer cannot look this up, the row is gone.
      expect(event.performed_at).toBe(performedAt);
      expect(typeof event.event_id).toBe('string');
      expect(typeof event.occurred_at).toBe('string');
      channel.ack(msg);
    } finally {
      await channel.close();
      await conn.close();
    }
  });

  // T040. The RabbitMQ event is already covered above; this is the notification
  // beside it — a different transport with a different contract and a different
  // failure policy, so it needs its own assertions.
  describe('workout.deleted notification (T039, FR-030)', () => {
    it('publishes workout.deleted on the owner channel, carrying the week', async () => {
      const workoutId = await seedWorkout(userId);
      const listener = await NotificationListener.open(accessToken);

      try {
        const res = await request(httpServer(app))
          .delete(`/api/workouts/${workoutId}`)
          .set('authorization', `Bearer ${accessToken}`);
        expect(res.status).toBe(204);

        const note = await listener.waitFor(
          (n) => n.type === WORKOUT_DELETED_KEY && 'workout_id' in n && n.workout_id === workoutId,
        );
        expect(note).not.toBeNull();
        expect(note).toMatchObject({
          type: WORKOUT_DELETED_KEY,
          user_id: userId,
          workout_id: workoutId,
          // Read off the entity before the transaction: by the time this
          // publishes the row is gone, and a week-scoped screen has nothing
          // left to look the date up from.
          performed_at: '2020-06-01T00:00:00.000Z',
        });
      } finally {
        listener.close();
      }
    });

    it('still returns 204 when the notification cannot be published (FR-030)', async () => {
      const workoutId = await seedWorkout(userId);
      const redis = app.get<Redis>(REDIS_CLIENT);
      const publish = vi
        .spyOn(redis, 'publish')
        .mockRejectedValue(new Error('redis is down') as never);

      try {
        const res = await request(httpServer(app))
          .delete(`/api/workouts/${workoutId}`)
          .set('authorization', `Bearer ${accessToken}`);
        expect(res.status).toBe(204);
        expect(publish).toHaveBeenCalled();
      } finally {
        publish.mockRestore();
      }
    });

    it('deletes the workout even though the notification failed', async () => {
      // The deletion is the durable half. A swallowed notification leaves other
      // screens stale until their next refetch, which FR-030 accepts; leaving
      // the row behind would be a different thing entirely.
      const workoutId = await seedWorkout(userId);
      const redis = app.get<Redis>(REDIS_CLIENT);
      const publish = vi
        .spyOn(redis, 'publish')
        .mockRejectedValue(new Error('redis is down') as never);

      try {
        await request(httpServer(app))
          .delete(`/api/workouts/${workoutId}`)
          .set('authorization', `Bearer ${accessToken}`)
          .expect(204);
      } finally {
        publish.mockRestore();
      }

      const ds = createTypeOrmDataSource();
      await ds.initialize();
      const rows = (await ds.query('SELECT id FROM workouts WHERE id = $1', [
        workoutId,
      ])) as unknown[];
      await ds.destroy();
      expect(rows).toHaveLength(0);
    });
  });
});
