import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTypeOrmDataSource } from '@workout-logging/shared';

import { AuthModule } from '../../src/auth/auth.module';
import { createTestApp, deleteTestUsers, httpServer, testEmailFactory } from '../helpers/test-app';

describe('POST /auth/register (contract, per contracts/api.md)', () => {
  let app: NestFastifyApplication;
  const emails = testEmailFactory('t026');

  beforeAll(async () => {
    app = await createTestApp([AuthModule]);
  });

  afterAll(async () => {
    await deleteTestUsers(emails.all());
    await app.close();
  });

  it('returns 201 with access_token, refresh_token, and user on success', async () => {
    const email = emails.next('ok');
    const res = await request(httpServer(app))
      .post('/api/auth/register')
      .send({ email, password: 'correct horse battery staple' });

    expect(res.status).toBe(201);
    expect(res.body.user).toEqual({ id: expect.any(String), email });
    expect(typeof res.body.access_token).toBe('string');
    // Refresh token is `{refreshTokens.id}.{secret}` (research.md #6 selector/validator split).
    expect(res.body.refresh_token.split('.')).toHaveLength(2);
  });

  it('returns 409 for an already-registered email', async () => {
    const email = emails.next('dup');
    await request(httpServer(app))
      .post('/api/auth/register')
      .send({ email, password: 'correct horse battery staple' });

    const res = await request(httpServer(app))
      .post('/api/auth/register')
      .send({ email, password: 'a different password entirely' });

    expect(res.status).toBe(409);
  });

  it('returns 400 for an invalid email', async () => {
    const res = await request(httpServer(app))
      .post('/api/auth/register')
      .send({ email: 'not-an-email', password: 'correct horse battery staple' });

    expect(res.status).toBe(400);
  });

  it('returns 400 for a password shorter than 8 characters', async () => {
    const res = await request(httpServer(app))
      .post('/api/auth/register')
      .send({ email: emails.next('shortpw'), password: 'abc' });

    expect(res.status).toBe(400);
  });

  it('normalizes email (trim + lowercase) so a mixed-case address logs in (T051)', async () => {
    const email = emails.next('case');
    const reg = await request(httpServer(app))
      .post('/api/auth/register')
      .send({ email: `  ${email.toUpperCase()}  `, password: 'correct horse battery staple' });

    expect(reg.status).toBe(201);
    expect(reg.body.user.email).toBe(email); // stored canonicalised

    const login = await request(httpServer(app))
      .post('/api/auth/login')
      .send({ email, password: 'correct horse battery staple' });
    expect(login.status).toBe(200);
  });

  it('returns 400 for an over-long password (argon2 DoS guard, T051)', async () => {
    const res = await request(httpServer(app))
      .post('/api/auth/register')
      .send({ email: emails.next('longpw'), password: 'x'.repeat(201) });

    expect(res.status).toBe(400);
  });

  it('returns 400 for an unexpected extra field (forbidNonWhitelisted)', async () => {
    const res = await request(httpServer(app))
      .post('/api/auth/register')
      .send({
        email: emails.next('extra'),
        password: 'correct horse battery staple',
        isAdmin: true,
      });

    expect(res.status).toBe(400);
  });

  it('stores the password as an argon2 hash, never plaintext', async () => {
    const email = emails.next('hash');
    const password = 'correct horse battery staple';
    await request(httpServer(app)).post('/api/auth/register').send({ email, password });

    const ds = createTypeOrmDataSource();
    await ds.initialize();
    const rows = await ds.query('SELECT password_hash FROM users WHERE email = $1', [email]);
    await ds.destroy();

    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0].password_hash).not.toContain(password);
  });
});
