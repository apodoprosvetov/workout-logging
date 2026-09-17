import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthModule } from '../../src/auth/auth.module';
import { EventsModule } from '../../src/events/events.module';
import { listenOnRandomPort, openSse, type SseConnection } from '../helpers/sse';
import { createTestApp, deleteTestUsers, httpServer, testEmailFactory } from '../helpers/test-app';

describe('GET /events — authentication and headers (contract, per contracts/api.md)', () => {
  let app: NestFastifyApplication;
  let port: number;
  let accessToken: string;
  const emails = testEmailFactory('events-auth');
  const password = 'correct horse battery staple';
  const open: SseConnection[] = [];

  beforeAll(async () => {
    app = await createTestApp([AuthModule, EventsModule]);
    port = await listenOnRandomPort(app);

    const email = emails.next('holder');
    const res = await request(httpServer(app)).post('/api/auth/register').send({ email, password });
    accessToken = (res.body as { access_token: string }).access_token;
  });

  afterAll(async () => {
    for (const c of open) c.close();
    // Let the teardowns reach the server before its Redis connection goes: a
    // close that lands after shutdown logs a harmless but noisy unsubscribe
    // failure, which would mask a real one.
    await new Promise((r) => setTimeout(r, 200));
    await app.close();
    await deleteTestUsers(emails.all());
  });

  async function connect(token: string | null): Promise<SseConnection> {
    const c = await openSse(port, token);
    open.push(c);
    return c;
  }

  it('rejects a request with no Authorization header', async () => {
    const c = await connect(null);
    expect(c.status).toBe(401);
  });

  it('rejects a malformed token', async () => {
    const c = await connect('not-a-jwt');
    expect(c.status).toBe(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    // Structurally valid JWT, wrong signature — proves the guard verifies rather
    // than merely decodes. A decode-only guard would also break the FR-006
    // expiry timer, which trusts `exp` from a *verified* payload.
    const forged = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(
        JSON.stringify({ sub: 'nobody', exp: Math.floor(Date.now() / 1000) + 900 }),
      ).toString('base64url'),
      'not-a-real-signature',
    ].join('.');
    const c = await connect(forged);
    expect(c.status).toBe(401);
  });

  it('opens a stream for a valid token', async () => {
    const c = await connect(accessToken);
    expect(c.status).toBe(200);
    expect(c.headers['content-type']).toContain('text/event-stream');
  });

  it('sets the anti-buffering headers the CDN and proxies need', async () => {
    const c = await connect(accessToken);

    // research #9: CloudFront applies a 30s origin read timeout and any
    // intermediary may buffer a stream into invisibility. These are what stop
    // that, and contracts/api.md pins them.
    expect(c.headers['cache-control']).toContain('no-cache');
    expect(c.headers['cache-control']).toContain('no-transform');
    expect(c.headers['x-accel-buffering']).toBe('no');
  });

  it('does not duplicate headers that @Sse() already sets', async () => {
    const c = await connect(accessToken);

    // research #12: Nest's @Sse() emits these itself. Adding @Header() for them
    // produced two values on the wire, which node collapses into a comma-joined
    // string — so a duplicate shows up as a repeated directive here.
    const cacheControl = String(c.headers['cache-control']);
    expect(cacheControl.match(/no-transform/g)).toHaveLength(1);
    expect(Array.isArray(c.headers['x-accel-buffering'])).toBe(false);
  });
});
