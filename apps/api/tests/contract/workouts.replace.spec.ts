import { randomUUID } from 'node:crypto';

import { getConnectionToken } from '@nestjs/mongoose';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Connection } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createTypeOrmDataSource,
  OutboxEvent,
  seedExerciseCatalog,
  Workout,
  WorkoutSource,
  WorkoutStatus,
} from '@workout-logging/shared';

import { AuthModule } from '../../src/auth/auth.module';
import { WorkoutsModule } from '../../src/workouts/workouts.module';
import { createTestApp, httpServer, testEmailFactory } from '../helpers/test-app';

import type { DataSource } from 'typeorm';

// PUT /workouts/:id — full replacement of a parsed workout's editable content.
describe('PUT /workouts/:id (contract)', () => {
  let app: NestFastifyApplication;
  let ds: DataSource;
  const emails = testEmailFactory('replace');
  const password = 'correct horse battery staple';
  let accessToken: string;
  let userId: string;
  let otherUserId: string;

  // Deliberately not bench-press/squat/lateral-raise/barbell-curl: other contract
  // specs own those `exercises` rows and force their display names, which the
  // Mongo catalog spells differently. Asserting a canonical name here would then
  // depend on spec order.
  const PRESS = 'machine chest press'; // -> 'Machine Chest Press'
  const INCLINE = 'incline dumbbell press'; // -> 'Incline Dumbbell Press'

  async function registerAndGetToken(label: string) {
    const res = await request(httpServer(app))
      .post('/api/auth/register')
      .send({ email: emails.next(label), password });
    const body = res.body as { access_token: string; user: { id: string } };
    return { userId: body.user.id, accessToken: body.access_token };
  }

  async function seedWorkout(
    owner: string,
    status: WorkoutStatus = WorkoutStatus.PARSED,
    performedAt = '2026-04-07T00:00:00.000Z',
  ): Promise<string> {
    const repo = ds.getRepository(Workout);
    const saved = await repo.save(
      repo.create({
        userId: owner,
        source: WorkoutSource.WEB,
        hasText: true,
        hasImage: false,
        rawInputRef: randomUUID(),
        status,
        performedAt: new Date(performedAt),
      }),
    );
    return saved.id;
  }

  function put(id: string, body: unknown, token = accessToken) {
    return request(httpServer(app))
      .put(`/api/workouts/${id}`)
      .set('authorization', `Bearer ${token}`)
      .send(body as object);
  }

  const validBody = (overrides: Record<string, unknown> = {}) => ({
    name: 'Push day',
    performed_at: '2026-04-09T00:00:00.000Z',
    exercises: [{ name: PRESS, sets: [{ weight: 80, reps: 5, unit: 'kg' }] }],
    ...overrides,
  });

  beforeAll(async () => {
    app = await createTestApp([AuthModule, WorkoutsModule]);
    ds = await createTypeOrmDataSource().initialize();
    await seedExerciseCatalog();

    const mine = await registerAndGetToken('mine');
    userId = mine.userId;
    accessToken = mine.accessToken;
    otherUserId = (await registerAndGetToken('other')).userId;
  }, 60_000);

  afterAll(async () => {
    // The harness stops the relay, so every outbox row these tests commit stays
    // unpublished. Left behind they accumulate across runs and eventually fill
    // OutboxRelayService's 50-row batch, which breaks outbox-relay.service.spec.
    await ds.query("DELETE FROM outbox WHERE payload->>'user_id' = ANY($1)", [
      [userId, otherUserId],
    ]);
    await ds.destroy();
    await app.close();
  });

  describe('replacing content', () => {
    it('replaces name and date, leaving the exercise tree equivalent', async () => {
      const id = await seedWorkout(userId);
      await put(id, validBody()).expect(200);

      const res = await put(
        id,
        validBody({ name: 'Renamed', performed_at: '2026-04-10T00:00:00.000Z' }),
      );
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Renamed');
      expect(res.body.performed_at).toBe('2026-04-10T00:00:00.000Z');
      expect(res.body.exercises).toHaveLength(1);
      expect(res.body.exercises[0].name).toBe('Machine Chest Press');
    });

    it('adds, removes and reorders exercises in one request', async () => {
      const id = await seedWorkout(userId);
      await put(
        id,
        validBody({
          exercises: [
            { name: PRESS, sets: [{ weight: 80, reps: 5, unit: 'kg' }] },
            { name: INCLINE, sets: [{ weight: 30, reps: 8, unit: 'kg' }] },
          ],
        }),
      ).expect(200);

      // Drop bench, keep incline, and put a new one ahead of it.
      const res = await put(
        id,
        validBody({
          exercises: [
            { name: 'dumbbell bench press', sets: [{ weight: 40, reps: 6, unit: 'kg' }] },
            { name: INCLINE, sets: [{ weight: 32.5, reps: 8, unit: 'kg' }] },
          ],
        }),
      );

      expect(res.status).toBe(200);
      expect(res.body.exercises.map((e: { name: string }) => e.name)).toEqual([
        'Dumbbell Bench Press',
        'Incline Dumbbell Press',
      ]);
      expect(res.body.exercises.map((e: { order: number }) => e.order)).toEqual([1, 2]);
    });

    it('adds, removes, reorders and edits sets within an exercise', async () => {
      const id = await seedWorkout(userId);
      await put(
        id,
        validBody({
          exercises: [
            {
              name: PRESS,
              sets: [
                { weight: 60, reps: 10, unit: 'kg' },
                { weight: 80, reps: 5, unit: 'kg' },
                { weight: 90, reps: 3, unit: 'kg' },
              ],
            },
          ],
        }),
      ).expect(200);

      const res = await put(
        id,
        validBody({
          exercises: [
            {
              name: PRESS,
              sets: [
                { weight: 100, reps: 2, unit: 'lb' }, // new, first
                { weight: 85, reps: 5, unit: 'kg' }, // edited weight
              ],
            },
          ],
        }),
      );

      expect(res.status).toBe(200);
      expect(res.body.exercises[0].sets).toEqual([
        { order: 1, weight: 100, reps: 2, unit: 'lb' },
        { order: 2, weight: 85, reps: 5, unit: 'kg' },
      ]);
    });

    it('numbers exercises and sets from 1, as the parser does', async () => {
      // apps/web renders `set.order` as the visible set number, and the parser
      // writes 1-based. A 0-based edit would make the same workout read "0,1,2"
      // after a round-trip through PUT.
      const id = await seedWorkout(userId);
      const res = await put(
        id,
        validBody({
          exercises: [
            {
              name: PRESS,
              sets: [
                { weight: 80, reps: 5, unit: 'kg' },
                { weight: 85, reps: 3, unit: 'kg' },
              ],
            },
            { name: INCLINE, sets: [{ weight: 30, reps: 8, unit: 'kg' }] },
          ],
        }),
      );
      expect(res.status).toBe(200);
      expect(res.body.exercises.map((e: { order: number }) => e.order)).toEqual([1, 2]);
      expect(res.body.exercises[0].sets.map((x: { order: number }) => x.order)).toEqual([1, 2]);
      expect(res.body.exercises[1].sets.map((x: { order: number }) => x.order)).toEqual([1]);
    });

    it('returns the same shape as reading the workout back', async () => {
      const id = await seedWorkout(userId);
      const put1 = await put(id, validBody());
      const get1 = await request(httpServer(app))
        .get(`/api/workouts/${id}`)
        .set('authorization', `Bearer ${accessToken}`);

      expect(put1.status).toBe(200);
      expect(get1.status).toBe(200);
      expect(put1.body).toEqual(get1.body);
    });

    it('settles as parsed from needs_review and stays parsed from parsed', async () => {
      const fromReview = await seedWorkout(userId, WorkoutStatus.NEEDS_REVIEW);
      const a = await put(fromReview, validBody());
      expect(a.status).toBe(200);
      expect(a.body.status).toBe('parsed');

      const fromParsed = await seedWorkout(userId, WorkoutStatus.PARSED);
      const b = await put(fromParsed, validBody());
      expect(b.status).toBe(200);
      expect(b.body.status).toBe('parsed');
    });

    it('stores null when the name is omitted', async () => {
      const id = await seedWorkout(userId);
      const body = validBody();
      delete (body as { name?: unknown }).name;
      const res = await put(id, body);
      expect(res.status).toBe(200);
      expect(res.body.name).toBeNull();
    });

    it('writes one outbox event carrying both the old and the new date', async () => {
      const id = await seedWorkout(userId, WorkoutStatus.PARSED, '2026-04-07T00:00:00.000Z');
      await put(id, validBody({ performed_at: '2026-05-19T00:00:00.000Z' })).expect(200);

      const rows = (
        await ds.getRepository(OutboxEvent).find({ where: { routingKey: 'workout.updated' } })
      ).filter((r) => (r.payload as { workout_id: string }).workout_id === id);

      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toMatchObject({
        type: 'workout.updated',
        user_id: userId,
        previous_performed_at: '2026-04-07T00:00:00.000Z',
        performed_at: '2026-05-19T00:00:00.000Z',
      });
    });
  });

  describe('refusals', () => {
    it('409 for a workout still being parsed', async () => {
      const id = await seedWorkout(userId, WorkoutStatus.PENDING);
      const res = await put(id, validBody());
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/still being processed/i);
    });

    it('409 for a failed workout', async () => {
      const id = await seedWorkout(userId, WorkoutStatus.FAILED);
      expect((await put(id, validBody())).status).toBe(409);
    });

    it("404 for another user's workout, without revealing it exists", async () => {
      const id = await seedWorkout(otherUserId);
      const res = await put(id, validBody());
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain(id);
    });

    it('404 for a workout that does not exist', async () => {
      expect((await put(randomUUID(), validBody())).status).toBe(404);
    });

    it('400 naming every exercise that is not in the catalog', async () => {
      const id = await seedWorkout(userId);
      const res = await put(
        id,
        validBody({
          exercises: [
            { name: 'zzz not a real lift', sets: [{ weight: 1, reps: 1, unit: 'kg' }] },
            { name: PRESS, sets: [{ weight: 80, reps: 5, unit: 'kg' }] },
            { name: 'yyy also not real', sets: [{ weight: 1, reps: 1, unit: 'kg' }] },
          ],
        }),
      );

      expect(res.status).toBe(400);
      // Every miss, not just the first — a caller fixes them in one pass.
      expect(res.body.unresolved_exercises).toEqual(
        expect.arrayContaining(['zzz not a real lift', 'yyy also not real']),
      );
      expect(res.body.unresolved_exercises).toHaveLength(2);
    });

    it('400 for an empty exercise list', async () => {
      const id = await seedWorkout(userId);
      expect((await put(id, validBody({ exercises: [] }))).status).toBe(400);
    });

    it('400 for an exercise carrying no sets', async () => {
      const id = await seedWorkout(userId);
      const res = await put(id, validBody({ exercises: [{ name: PRESS, sets: [] }] }));
      expect(res.status).toBe(400);
    });

    it.each([
      ['a negative weight', { weight: -1, reps: 5, unit: 'kg' }],
      ['zero reps', { weight: 80, reps: 0, unit: 'kg' }],
      ['fractional reps', { weight: 80, reps: 2.5, unit: 'kg' }],
      ['an unknown unit', { weight: 80, reps: 5, unit: 'stone' }],
    ])('400 for %s', async (_label, set) => {
      const id = await seedWorkout(userId);
      const res = await put(id, validBody({ exercises: [{ name: PRESS, sets: [set] }] }));
      expect(res.status).toBe(400);
    });

    it('400 for an unparseable performed_at', async () => {
      const id = await seedWorkout(userId);
      expect((await put(id, validBody({ performed_at: 'last tuesday' }))).status).toBe(400);
    });

    it('400 for an explicit order field, which the body must not carry', async () => {
      const id = await seedWorkout(userId);
      const res = await put(
        id,
        validBody({
          exercises: [{ name: PRESS, order: 3, sets: [{ weight: 80, reps: 5, unit: 'kg' }] }],
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe('an unreachable catalog is not the caller’s fault', () => {
    it('503, and does not report the submitted exercises as unknown', async () => {
      const id = await seedWorkout(userId);
      const connection = app.get<Connection>(getConnectionToken());
      const model = connection.model('ExerciseCatalog');
      const find = vi
        .spyOn(model, 'find')
        .mockImplementation(
          () => ({ lean: () => Promise.reject(new Error('mongo is down')) }) as never,
        );

      try {
        const res = await put(id, validBody());
        expect(res.status).toBe(503);
        expect(res.body.message).toMatch(/nothing was saved/i);
        expect(JSON.stringify(res.body)).not.toContain(PRESS);
        expect(res.body.unresolved_exercises).toBeUndefined();
      } finally {
        find.mockRestore();
      }
    });
  });

  describe('a refused request changes nothing', () => {
    it.each([
      [
        'an unknown exercise',
        () =>
          validBody({
            exercises: [{ name: 'zzz not real', sets: [{ weight: 1, reps: 1, unit: 'kg' }] }],
          }),
      ],
      [
        'an invalid set',
        () =>
          validBody({ exercises: [{ name: PRESS, sets: [{ weight: -5, reps: 1, unit: 'kg' }] }] }),
      ],
      ['no exercises', () => validBody({ exercises: [] })],
    ])('leaves the workout untouched after %s', async (_label, body) => {
      const id = await seedWorkout(userId, WorkoutStatus.NEEDS_REVIEW, '2026-04-07T00:00:00.000Z');
      await put(id, validBody()).expect(200); // give it real content first
      const before = await request(httpServer(app))
        .get(`/api/workouts/${id}`)
        .set('authorization', `Bearer ${accessToken}`);

      const refused = await put(id, body());
      expect(refused.status).toBeGreaterThanOrEqual(400);

      const after = await request(httpServer(app))
        .get(`/api/workouts/${id}`)
        .set('authorization', `Bearer ${accessToken}`);
      expect(after.body).toEqual(before.body);
    });

    it('creates no catalog entry for a name that did not resolve', async () => {
      const id = await seedWorkout(userId);
      const connection = app.get<Connection>(getConnectionToken());
      const catalog = connection.model('ExerciseCatalog');
      const name = `invented lift ${randomUUID()}`;

      await put(
        id,
        validBody({ exercises: [{ name, sets: [{ weight: 1, reps: 1, unit: 'kg' }] }] }),
      ).expect(400);

      expect(await catalog.countDocuments({ name })).toBe(0);
    });
  });
});
