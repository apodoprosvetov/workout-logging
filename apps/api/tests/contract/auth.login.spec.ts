import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthModule } from '../../src/auth/auth.module';
import { createTestApp, deleteTestUsers, httpServer, testEmailFactory } from '../helpers/test-app';

describe('POST /auth/login (contract, per contracts/api.md)', () => {
  let app: NestFastifyApplication;
  const emails = testEmailFactory('t027');
  const password = 'correct horse battery staple';
  let registeredEmail: string;

  beforeAll(async () => {
    app = await createTestApp([AuthModule]);

    registeredEmail = emails.next('base');
    await request(httpServer(app)).post('/auth/register').send({ email: registeredEmail, password });
  });

  afterAll(async () => {
    await deleteTestUsers(emails.all());
    await app.close();
  });

  it('returns 200 with access_token and refresh_token for correct credentials', async () => {
    const res = await request(httpServer(app)).post('/auth/login').send({ email: registeredEmail, password });

    expect(res.status).toBe(200);
    expect(typeof res.body.access_token).toBe('string');
    expect(res.body.refresh_token.split('.')).toHaveLength(2);
    // Login response has no `user` field (that's register-only, per contracts/api.md).
    expect(res.body.user).toBeUndefined();
  });

  it('returns 401 for a wrong password', async () => {
    const res = await request(httpServer(app))
      .post('/auth/login')
      .send({ email: registeredEmail, password: 'the wrong password entirely' });

    expect(res.status).toBe(401);
  });

  it('returns 401 for an email that was never registered', async () => {
    const res = await request(httpServer(app))
      .post('/auth/login')
      .send({ email: emails.next('unknown'), password });

    expect(res.status).toBe(401);
  });

  it('returns 400 for an invalid email format', async () => {
    const res = await request(httpServer(app)).post('/auth/login').send({ email: 'not-an-email', password });

    expect(res.status).toBe(400);
  });

  it('returns 400 when password is missing', async () => {
    const res = await request(httpServer(app)).post('/auth/login').send({ email: registeredEmail });

    expect(res.status).toBe(400);
  });

  it('issues a working access token distinct from the one issued at registration', async () => {
    const res = await request(httpServer(app)).post('/auth/login').send({ email: registeredEmail, password });

    const payload = JSON.parse(Buffer.from(res.body.access_token.split('.')[1], 'base64url').toString());
    expect(typeof payload.sub).toBe('string');
  });
});
