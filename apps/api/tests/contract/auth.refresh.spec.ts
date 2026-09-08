import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthModule } from '../../src/auth/auth.module';
import { createTestApp, deleteTestUsers, httpServer, testEmailFactory } from '../helpers/test-app';

describe('POST /auth/refresh (contract, per contracts/api.md)', () => {
  let app: NestFastifyApplication;
  const emails = testEmailFactory('t028');
  const password = 'correct horse battery staple';

  beforeAll(async () => {
    app = await createTestApp([AuthModule]);
  });

  afterAll(async () => {
    await deleteTestUsers(emails.all());
    await app.close();
  });

  async function registerAndGetTokens(label: string) {
    const email = emails.next(label);
    const res = await request(httpServer(app)).post('/api/auth/register').send({ email, password });
    return { email, ...(res.body as { access_token: string; refresh_token: string }) };
  }

  it('returns 200 with a new access_token and a rotated refresh_token', async () => {
    const { refresh_token } = await registerAndGetTokens('ok');

    const res = await request(httpServer(app)).post('/api/auth/refresh').send({ refresh_token });

    expect(res.status).toBe(200);
    expect(typeof res.body.access_token).toBe('string');
    expect(res.body.refresh_token.split('.')).toHaveLength(2);
    // Cryptographically random, unlike the JWT access_token — an unambiguous rotation check
    // (same-second JWTs can be byte-identical, see T025's note).
    expect(res.body.refresh_token).not.toBe(refresh_token);
  });

  it('rejects reuse of an already-rotated refresh_token (research.md #6)', async () => {
    const { refresh_token } = await registerAndGetTokens('reuse');

    const first = await request(httpServer(app)).post('/api/auth/refresh').send({ refresh_token });
    expect(first.status).toBe(200);

    const reuse = await request(httpServer(app)).post('/api/auth/refresh').send({ refresh_token });
    expect(reuse.status).toBe(401);
  });

  it('the newly-issued refresh_token from rotation works for a subsequent refresh', async () => {
    const { refresh_token } = await registerAndGetTokens('chain');

    const first = await request(httpServer(app)).post('/api/auth/refresh').send({ refresh_token });
    const second = await request(httpServer(app))
      .post('/api/auth/refresh')
      .send({ refresh_token: first.body.refresh_token });

    expect(second.status).toBe(200);
  });

  it('returns 401 for a syntactically-invalid refresh_token', async () => {
    const res = await request(httpServer(app))
      .post('/api/auth/refresh')
      .send({ refresh_token: 'not-a-real-token' });

    expect(res.status).toBe(401);
  });

  it('returns 401 for a well-formed but unknown token id', async () => {
    const res = await request(httpServer(app))
      .post('/api/auth/refresh')
      .send({ refresh_token: '00000000-0000-0000-0000-000000000000.deadbeef' });

    expect(res.status).toBe(401);
  });

  it('returns 400 when refresh_token is missing', async () => {
    const res = await request(httpServer(app)).post('/api/auth/refresh').send({});

    expect(res.status).toBe(400);
  });

  it('returns 400 for an over-long refresh_token (T051)', async () => {
    const res = await request(httpServer(app))
      .post('/api/auth/refresh')
      .send({ refresh_token: 'a'.repeat(513) });

    expect(res.status).toBe(400);
  });

  it('the new access_token carries the correct user id', async () => {
    const { refresh_token } = await registerAndGetTokens('sub');
    const res = await request(httpServer(app)).post('/api/auth/refresh').send({ refresh_token });

    const payload = JSON.parse(
      Buffer.from(res.body.access_token.split('.')[1], 'base64url').toString(),
    );
    expect(typeof payload.sub).toBe('string');
  });
});
