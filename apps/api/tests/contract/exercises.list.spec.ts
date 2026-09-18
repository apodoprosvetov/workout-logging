import { getConnectionToken } from '@nestjs/mongoose';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Connection } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { seedExerciseCatalog } from '@workout-logging/shared';

import { AuthModule } from '../../src/auth/auth.module';
import { ExercisesModule } from '../../src/exercises/exercises.module';
import { createTestApp, deleteTestUsers, httpServer, testEmailFactory } from '../helpers/test-app';

interface CatalogEntry {
  slug: string;
  name: string;
  aliases: string[];
  muscle_groups: string[];
  equipment: string | null;
}

// GET /exercises — the exercise catalog, read-only, for a signed-in caller.
describe('GET /exercises (contract)', () => {
  let app: NestFastifyApplication;
  const emails = testEmailFactory('exercises');
  const password = 'correct horse battery staple';
  let accessToken: string;
  let otherAccessToken: string;

  async function registerAndGetToken(label: string): Promise<string> {
    const res = await request(httpServer(app))
      .post('/api/auth/register')
      .send({ email: emails.next(label), password });
    return (res.body as { access_token: string }).access_token;
  }

  function get(token = accessToken) {
    return request(httpServer(app)).get('/api/exercises').set('authorization', `Bearer ${token}`);
  }

  // Replaces the model's read for one test. The service calls
  // find({}).sort().lean(), so the whole chain has to be stood up. `result` is
  // a factory, not a promise: a rejection built before `lean()` is called has
  // no handler for a tick, and vitest reports it as an unhandled rejection.
  function stubCatalogRead(result: () => Promise<unknown>) {
    const model = app.get<Connection>(getConnectionToken()).model('ExerciseCatalog');
    return vi
      .spyOn(model, 'find')
      .mockImplementation(() => ({ sort: () => ({ lean: result }) }) as never);
  }

  beforeAll(async () => {
    app = await createTestApp([AuthModule, ExercisesModule]);
    await seedExerciseCatalog();
    accessToken = await registerAndGetToken('mine');
    otherAccessToken = await registerAndGetToken('other');
  });

  afterAll(async () => {
    await app?.close();
    await deleteTestUsers(emails.all());
  });

  it('200 with the seeded catalog, ordered by name', async () => {
    const res = await get();

    expect(res.status).toBe(200);
    const entries = res.body as CatalogEntry[];
    expect(entries.length).toBeGreaterThan(50);

    const names = entries.map((entry) => entry.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('carries every documented field, with equipment null rather than absent', async () => {
    const entries = (await get()).body as CatalogEntry[];

    const bench = entries.find((entry) => entry.slug === 'bench-press');
    expect(bench).toMatchObject({
      slug: 'bench-press',
      name: expect.any(String),
      aliases: expect.any(Array),
      muscle_groups: expect.arrayContaining(['chest']),
    });
    expect(bench?.aliases.length).toBeGreaterThan(0);

    // A bodyweight entry records no equipment. The key must still be there:
    // omitting it makes "unknown" indistinguishable from "not answered".
    for (const entry of entries) {
      expect(entry).toHaveProperty('equipment');
    }
  });

  it('answers the same catalog to different users', async () => {
    const mine = (await get()).body as CatalogEntry[];
    const theirs = (await get(otherAccessToken)).body as CatalogEntry[];

    expect(theirs).toEqual(mine);
  });

  it('401 without a token', async () => {
    const res = await request(httpServer(app)).get('/api/exercises');

    expect(res.status).toBe(401);
  });

  it('503 when the catalog cannot be read', async () => {
    const find = stubCatalogRead(() => Promise.reject(new Error('mongo is down')));

    try {
      const res = await get();
      expect(res.status).toBe(503);
      expect(res.body.message).toMatch(/catalog/i);
    } finally {
      find.mockRestore();
    }
  });

  it('200 with an empty array for a genuinely empty catalog', async () => {
    const find = stubCatalogRead(() => Promise.resolve([]));

    try {
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    } finally {
      find.mockRestore();
    }
  });
});
