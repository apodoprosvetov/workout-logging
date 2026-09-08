import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTypeOrmDataSource, Workout, WorkoutSource, WorkoutStatus } from '@workout-logging/shared';

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
    const res = await request(httpServer(app)).post('/api/auth/register').send({ email, password });
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
    const res = await request(httpServer(app)).get('/api/workouts');
    expect(res.status).toBe(401);
  });

  it('returns 401 for a tampered bearer token (signature check, T053)', async () => {
    const [h, p] = accessToken.split('.');
    const forged = `${h}.${p}.deadbeefdeadbeefdeadbeefdeadbeef`;
    const res = await request(httpServer(app)).get('/api/workouts').set('authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it("returns only the caller's own workouts, sorted by performedAt (not createdAt), newest first (FR-015)", async () => {
    const ds = createTypeOrmDataSource();
    await ds.initialize();

    const older = await seedWorkout(ds, userId, { performedAt: new Date('2020-01-01T00:00:00.000Z') });
    const newer = await seedWorkout(ds, userId, { performedAt: new Date('2020-01-02T00:00:00.000Z') });
    const otherUsersWorkout = await seedWorkout(ds, otherUserId);
    await ds.destroy();

    const res = await request(httpServer(app)).get('/api/workouts').set('authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    const ids = (res.body.data as Array<{ id: string }>).map((w) => w.id);
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older));
    expect(ids).not.toContain(otherUsersWorkout);
  });

  it('filters by status', async () => {
    const ds = createTypeOrmDataSource();
    await ds.initialize();
    const needsReviewId = await seedWorkout(ds, userId, { status: WorkoutStatus.NEEDS_REVIEW });
    await ds.destroy();

    const res = await request(httpServer(app))
      .get('/api/workouts?status=needs_review')
      .set('authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    const rows = res.body.data as Array<{ id: string; status: string }>;
    expect(rows.every((w) => w.status === 'needs_review')).toBe(true);
    expect(rows.map((w) => w.id)).toContain(needsReviewId);
  });

  it('respects per_page', async () => {
    const res = await request(httpServer(app))
      .get('/api/workouts?per_page=1')
      .set('authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('returns the pagination envelope, defaulting to page 1 and per_page 20', async () => {
    const res = await request(httpServer(app)).get('/api/workouts').set('authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    const body = res.body as {
      data: unknown[];
      total: number;
      page: number;
      per_page: number;
      next_page: number | null;
      prev_page: number | null;
    };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.page).toBe(1);
    expect(body.per_page).toBe(20);
    expect(typeof body.total).toBe('number');
    expect(body.prev_page).toBeNull();
  });

  it('walks every page exactly once, including rows that share a performed_at', async () => {
    // The case that broke the previous `before` cursor: with several workouts
    // on one date, a strict `performed_at < cursor` dropped the whole tie group
    // (reproduced against Postgres — two of three rows became unreachable).
    // Offset paging survives it only because the sort is a total order; this
    // test is what fails if the `id` tie-break is ever removed.
    const own = await registerAndGetToken('paging');
    const ds = createTypeOrmDataSource();
    await ds.initialize();
    const sameDay = new Date('2014-08-11T00:00:00.000Z');
    const seeded: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      seeded.push(
        await seedWorkout(ds, own.userId, {
          // 5 of 7 share one performed_at, so a page boundary at per_page=2
          // necessarily falls inside the tie group.
          performedAt: i < 5 ? sameDay : new Date(`2014-08-1${i}T00:00:00.000Z`),
        }),
      );
    }
    await ds.destroy();

    const seen: string[] = [];
    let page: number | null = 1;
    for (let guard = 0; page !== null && guard < 10; guard += 1) {
      const res = await request(httpServer(app))
        .get(`/api/workouts?page=${page}&per_page=2`)
        .set('authorization', `Bearer ${own.accessToken}`);
      expect(res.status).toBe(200);
      const body = res.body as { data: Array<{ id: string }>; total: number; next_page: number | null };
      expect(body.total).toBe(seeded.length);
      seen.push(...body.data.map((w) => w.id));
      page = body.next_page;
    }

    expect(seen).toHaveLength(seeded.length); // nothing repeated
    expect([...seen].sort()).toEqual([...seeded].sort()); // nothing skipped
  });

  it('returns an empty page, not an error, past the last page', async () => {
    const res = await request(httpServer(app))
      .get('/api/workouts?page=9999&per_page=20')
      .set('authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[]; next_page: number | null };
    expect(body.data).toEqual([]);
    expect(body.next_page).toBeNull();
  });

  it('orders workouts sharing a performed_at deterministically, by id desc', async () => {
    // performedAt alone is not a total order, and ties are ordinary here: the
    // web form supplies a date, so everything logged for one day collides to
    // the microsecond. Without the id tie-break Postgres returns tied rows in
    // plan-dependent order (confirmed: A,B,C on a seq scan, C,B,A on an index
    // scan), which makes any pagination over them unsound.
    const ds = createTypeOrmDataSource();
    await ds.initialize();
    const sharedPerformedAt = new Date('2015-04-07T00:00:00.000Z');
    const tiedIds = [
      await seedWorkout(ds, userId, { performedAt: sharedPerformedAt }),
      await seedWorkout(ds, userId, { performedAt: sharedPerformedAt }),
      await seedWorkout(ds, userId, { performedAt: sharedPerformedAt }),
    ];
    await ds.destroy();

    const fetchTiedOrder = async (): Promise<string[]> => {
      const res = await request(httpServer(app))
        .get('/api/workouts?per_page=100')
        .set('authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(200);
      return (res.body.data as Array<{ id: string }>)
        .map((w) => w.id)
        .filter((id) => tiedIds.includes(id));
    };

    const order = await fetchTiedOrder();
    expect(order).toHaveLength(tiedIds.length);
    // Contractual order, not merely "some stable order".
    expect(order).toEqual([...tiedIds].sort().reverse());
    // And it must not drift between identical requests.
    expect(await fetchTiedOrder()).toEqual(order);
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
      .get(`/api/workouts?before=${beforeCursor.toISOString()}`)
      .set('authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    const rows = res.body.data as Array<{ id: string; performed_at: string }>;
    expect(rows.every((w) => new Date(w.performed_at).getTime() < beforeCursor.getTime())).toBe(true);
    expect(rows.map((w) => w.id)).toContain(olderId);
    expect(rows.map((w) => w.id)).not.toContain(newerId);
  });

  it('filters by after (inclusive lower bound on performed_at)', async () => {
    const ds = createTypeOrmDataSource();
    await ds.initialize();
    const afterCursor = new Date('2018-06-01T00:00:00.000Z');
    const beforeCursorId = await seedWorkout(ds, userId, {
      performedAt: new Date('2018-05-01T00:00:00.000Z'),
    });
    const onCursorId = await seedWorkout(ds, userId, { performedAt: afterCursor });
    const afterCursorId = await seedWorkout(ds, userId, {
      performedAt: new Date('2018-07-01T00:00:00.000Z'),
    });
    await ds.destroy();

    const res = await request(httpServer(app))
      .get(`/api/workouts?after=${afterCursor.toISOString()}`)
      .set('authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    const rows = res.body.data as Array<{ id: string; performed_at: string }>;
    expect(rows.every((w) => new Date(w.performed_at).getTime() >= afterCursor.getTime())).toBe(true);
    expect(rows.map((w) => w.id)).toEqual(expect.arrayContaining([onCursorId, afterCursorId]));
    expect(rows.map((w) => w.id)).not.toContain(beforeCursorId);
  });

  it('fetches a single week with after + before as a half-open [after, before) window', async () => {
    const ds = createTypeOrmDataSource();
    await ds.initialize();
    const weekStart = new Date('2017-03-06T00:00:00.000Z'); // Monday
    const nextWeekStart = new Date('2017-03-13T00:00:00.000Z');
    const inWeekId = await seedWorkout(ds, userId, {
      performedAt: new Date('2017-03-08T12:00:00.000Z'),
    });
    const beforeWeekId = await seedWorkout(ds, userId, {
      performedAt: new Date('2017-03-05T12:00:00.000Z'),
    });
    const onNextWeekStartId = await seedWorkout(ds, userId, { performedAt: nextWeekStart });
    await ds.destroy();

    const res = await request(httpServer(app))
      .get(`/api/workouts?after=${weekStart.toISOString()}&before=${nextWeekStart.toISOString()}`)
      .set('authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    const ids = (res.body.data as Array<{ id: string }>).map((w) => w.id);
    expect(ids).toContain(inWeekId);
    expect(ids).not.toContain(beforeWeekId);
    expect(ids).not.toContain(onNextWeekStartId);
  });

  it('returns 400 for a malformed after value', async () => {
    const res = await request(httpServer(app))
      .get('/api/workouts?after=not-a-date')
      .set('authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid status value', async () => {
    const res = await request(httpServer(app))
      .get('/api/workouts?status=not-a-real-status')
      .set('authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(400);
  });

  it('returns 400 for a per_page over the max', async () => {
    const res = await request(httpServer(app))
      .get('/api/workouts?per_page=101')
      .set('authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(400);
  });

  it('returns 400 for a page below 1', async () => {
    const res = await request(httpServer(app))
      .get('/api/workouts?page=0')
      .set('authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(400);
  });

  it('rejects the retired limit parameter', async () => {
    // forbidNonWhitelisted in main.ts's ValidationPipe: `limit` is gone, and a
    // caller still sending it gets told so rather than silently paginated by
    // the defaults.
    const res = await request(httpServer(app))
      .get('/api/workouts?limit=5')
      .set('authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(400);
  });
});
