import { randomUUID } from 'node:crypto';

import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { EntityManager } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createTypeOrmDataSource,
  OutboxEvent,
  seedExerciseCatalog,
  WORKOUT_SETTLED_KEY,
  WORKOUT_UPDATED_KEY,
  Workout,
  WorkoutSource,
  WorkoutStatus,
} from '@workout-logging/shared';

import { AuthModule } from '../../src/auth/auth.module';
import { NotificationsPublisher } from '../../src/events/notifications.publisher';
import { WorkoutsModule } from '../../src/workouts/workouts.module';
import { createTestApp, httpServer, testEmailFactory } from '../helpers/test-app';

import type { DataSource } from 'typeorm';

describe('PUT /workouts/:id (integration: outbox + notification)', () => {
  let app: NestFastifyApplication;
  let ds: DataSource;
  const emails = testEmailFactory('replace-int');
  let accessToken: string;
  let userId: string;

  const PRESS = 'machine chest press';
  const body = {
    name: 'Push day',
    performed_at: '2026-04-09T00:00:00.000Z',
    exercises: [{ name: PRESS, sets: [{ weight: 80, reps: 5, unit: 'kg' }] }],
  };

  async function seedWorkout(): Promise<string> {
    const repo = ds.getRepository(Workout);
    const saved = await repo.save(
      repo.create({
        userId,
        source: WorkoutSource.WEB,
        hasText: true,
        hasImage: false,
        rawInputRef: randomUUID(),
        status: WorkoutStatus.PARSED,
        performedAt: new Date('2026-04-07T00:00:00.000Z'),
      }),
    );
    return saved.id;
  }

  function put(id: string) {
    return request(httpServer(app))
      .put(`/api/workouts/${id}`)
      .set('authorization', `Bearer ${accessToken}`)
      .send(body);
  }

  async function outboxRowsFor(workoutId: string) {
    const rows = await ds
      .getRepository(OutboxEvent)
      .find({ where: { routingKey: 'workout.updated' } });
    return rows.filter((r) => (r.payload as { workout_id: string }).workout_id === workoutId);
  }

  beforeAll(async () => {
    app = await createTestApp([AuthModule, WorkoutsModule]);
    ds = await createTypeOrmDataSource().initialize();
    await seedExerciseCatalog();

    const res = await request(httpServer(app))
      .post('/api/auth/register')
      .send({ email: emails.next('a'), password: 'correct horse battery staple' });
    const b = res.body as { access_token: string; user: { id: string } };
    accessToken = b.access_token;
    userId = b.user.id;
  }, 60_000);

  afterAll(async () => {
    // See workouts.replace.spec.ts: unpublished rows left here fill the relay's
    // batch and break outbox-relay.service.spec.
    await ds.query("DELETE FROM outbox WHERE payload->>'user_id' = $1", [userId]);
    await ds.destroy();
    await app.close();
  });

  it('commits the outbox row with the content, exactly once', async () => {
    const id = await seedWorkout();
    await put(id).expect(200);

    const rows = await outboxRowsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({
      type: 'workout.updated',
      previous_performed_at: '2026-04-07T00:00:00.000Z',
      performed_at: '2026-04-09T00:00:00.000Z',
    });
  });

  it('writes no outbox row and no content when the transaction fails', async () => {
    const id = await seedWorkout();
    // The prototype, not an instance: TypeORM builds the transactional manager
    // inside `transaction()` and never hands it out.
    const spy = vi
      .spyOn(EntityManager.prototype, 'insert')
      .mockRejectedValue(new Error('outbox insert failed'));

    try {
      const res = await put(id);
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      spy.mockRestore();
    }

    expect(await outboxRowsFor(id)).toHaveLength(0);

    // The content rolled back with it — still the seeded date, still no exercises.
    const after = await request(httpServer(app))
      .get(`/api/workouts/${id}`)
      .set('authorization', `Bearer ${accessToken}`);
    expect(after.body.performed_at).toBe('2026-04-07T00:00:00.000Z');
    expect(after.body.exercises).toHaveLength(0);
  });

  it('two overlapping replacements leave one tree, not two', async () => {
    // Without a lock both requests delete the tree their own snapshot saw and
    // insert their own; the second delete matches nothing and raises no error,
    // so the workout ends up carrying both and the user sees every exercise
    // twice.
    const id = await seedWorkout();
    const [a, b] = await Promise.all([put(id), put(id)]);

    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);

    const after = await request(httpServer(app))
      .get(`/api/workouts/${id}`)
      .set('authorization', `Bearer ${accessToken}`);
    expect(after.body.exercises).toHaveLength(body.exercises.length);
    expect(after.body.exercises[0].sets).toHaveLength(1);
  });

  it('announces workout.updated, never workout.settled', async () => {
    const id = await seedWorkout();
    const publisher = app.get(NotificationsPublisher);
    const publish = vi.spyOn(publisher, 'publish');

    try {
      await put(id).expect(200);

      const types = publish.mock.calls.map((c) => (c[0] as { type: string }).type);
      expect(types).toContain(WORKOUT_UPDATED_KEY);
      // A settle means extraction completed; this workout was never in flight.
      expect(types).not.toContain(WORKOUT_SETTLED_KEY);
    } finally {
      publish.mockRestore();
    }
  });
});
