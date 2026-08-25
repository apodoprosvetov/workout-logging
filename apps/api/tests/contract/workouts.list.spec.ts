import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTypeOrmDataSource, Workout, WorkoutSource, WorkoutStatus } from '@workout-logging/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthModule } from '../../src/auth/auth.module';
import { WorkoutsModule } from '../../src/workouts/workouts.module';
import { createTestApp, deleteTestUsers, httpServer, testEmailFactory } from '../helpers/test-app';

describe('GET /workouts (contract, per contracts/api.md)', () => {
  let app: NestFastifyApplication;
  const emails = testEmailFactory('t033');
  const password = 'correct horse battery staple';
  let accessToken: string;
  let userId: string;
  let otherUserId: string;

  async function registerAndGetToken(label: string): Promise<{ userId: string; accessToken: string }> {
    const email = emails.next(label);
    const res = await request(httpServer(app)).post('/auth/register').send({ email, password });
    const body = res.body as { access_token: string; user: { id: string } };
    return { userId: body.user.id, accessToken: body.access_token };
  }

  async function seedWorkout(
    ds: Awaited<ReturnType<typeof createTypeOrmDataSource>>,
    forUserId: string,
    overrides: Partial<Pick<Workout, 'status' | 'performedAt' | 'name'>> = {},
  ): Promise<string> {
    const repo = ds.getRepository(Workout);
    const workout = await repo.save(
      repo.create({
        userId: forUserId,
        source: WorkoutSource.WEB,
        hasText: true,
        hasImage: false,
        rawInputRef: 'test-ref',
        status: overrides.status ?? WorkoutStatus.PARSED,
        performedAt: overrides.performedAt ?? new Date(),
        performedAtExplicit: !!overrides.performedAt,
        name: overrides.name ?? null,
      }),
    );
    return workout.id;
  }

  beforeAll(async () => {
    app = await createTestApp([AuthModule, WorkoutsModule]);
    const mine = await registerAndGetToken('mine');
    userId = mine.userId;
    accessToken = mine.accessToken;
    otherUserId = (await registerAndGetToken('other')).userId;
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
    await deleteTestUsers(emails.all());
    await app.close();
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await request(httpServer(app)).get('/workouts');
    expect(res.status).toBe(401);
  });

  it("returns only the caller's own workouts, sorted by performedAt (not createdAt), newest first (FR-015)", async () => {
    const ds = createTypeOrmDataSource();
    await ds.initialize();

    const older = await seedWorkout(ds, userId, { performedAt: new Date('2020-01-01T00:00:00.000Z') });
    const newer = await seedWorkout(ds, userId, { performedAt: new Date('2020-01-02T00:00:00.000Z') });
    const otherUsersWorkout = await seedWorkout(ds, otherUserId);
    await ds.destroy();

    const res = await request(httpServer(app)).get('/workouts').set('authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    const ids = (res.body.workouts as Array<{ id: string }>).map((w) => w.id);
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older));
    expect(ids).not.toContain(otherUsersWorkout);
  });

  it('filters by status', async () => {
    const ds = createTypeOrmDataSource();
    await ds.initialize();
    const needsReviewId = await seedWorkout(ds, userId, { status: WorkoutStatus.NEEDS_REVIEW });
    await ds.destroy();

    const res = await request(httpServer(app))
      .get('/workouts?status=needs_review')
      .set('authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    const rows = res.body.workouts as Array<{ id: string; status: string }>;
    expect(rows.every((w) => w.status === 'needs_review')).toBe(true);
    expect(rows.map((w) => w.id)).toContain(needsReviewId);
  });

  it('respects limit', async () => {
    const res = await request(httpServer(app))
      .get('/workouts?limit=1')
      .set('authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.workouts).toHaveLength(1);
  });

  it('paginates with before (by performed_at, not created_at)', async () => {
    const ds = createTypeOrmDataSource();
    await ds.initialize();
    const beforeCursor = new Date('2019-06-01T00:00:00.000Z');
    const olderId = await seedWorkout(ds, userId, {
      performedAt: new Date('2019-05-01T00:00:00.000Z'),
    });
    const newerId = await seedWorkout(ds, userId, {
      performedAt: new Date('2019-07-01T00:00:00.000Z'),
    });
    await ds.destroy();

    const res = await request(httpServer(app))
      .get(`/workouts?before=${beforeCursor.toISOString()}`)
      .set('authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    const rows = res.body.workouts as Array<{ id: string; performed_at: string }>;
    expect(rows.every((w) => new Date(w.performed_at).getTime() < beforeCursor.getTime())).toBe(true);
    expect(rows.map((w) => w.id)).toContain(olderId);
    expect(rows.map((w) => w.id)).not.toContain(newerId);
  });

  it('returns 400 for an invalid status value', async () => {
    const res = await request(httpServer(app))
      .get('/workouts?status=not-a-real-status')
      .set('authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(400);
  });

  it('returns 400 for a limit over the max', async () => {
    const res = await request(httpServer(app)).get('/workouts?limit=101').set('authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(400);
  });
});
