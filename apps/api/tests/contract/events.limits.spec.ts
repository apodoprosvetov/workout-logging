import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthModule } from '../../src/auth/auth.module';
import { EventsModule } from '../../src/events/events.module';
import { listenOnRandomPort, openSse, type SseConnection } from '../helpers/sse';
import { createTestApp, deleteTestUsers, httpServer, testEmailFactory } from '../helpers/test-app';

// Mirrors MAX_CONNECTIONS_PER_USER in src/events/connection-registry.ts. Kept as
// a literal rather than exported from the class: the cap is an internal policy,
// and a test that reads it from the implementation would pass no matter what the
// implementation said.
const CAP = 10;

describe('GET /events — per-user connection cap (contract, per contracts/api.md)', () => {
  let app: NestFastifyApplication;
  let port: number;
  const emails = testEmailFactory('events-limits');
  const password = 'correct horse battery staple';
  const open: SseConnection[] = [];

  let token: string;
  let otherToken: string;

  beforeAll(async () => {
    app = await createTestApp([AuthModule, EventsModule]);
    port = await listenOnRandomPort(app);
    token = await register('capped');
    otherToken = await register('other');
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

  async function register(label: string): Promise<string> {
    const email = emails.next(label);
    const res = await request(httpServer(app)).post('/api/auth/register').send({ email, password });
    return (res.body as { access_token: string }).access_token;
  }

  async function connect(t: string): Promise<SseConnection> {
    const c = await openSse(port, t);
    open.push(c);
    return c;
  }

  it('accepts connections up to the cap and refuses the next with 429', async () => {
    const accepted: SseConnection[] = [];
    for (let i = 0; i < CAP; i++) {
      accepted.push(await connect(token));
    }
    expect(accepted.every((c) => c.status === 200)).toBe(true);

    const refused = await connect(token);
    // 429, not 503: the two failures mean different things to a client — back
    // off your own connections, versus the backend is unavailable.
    expect(refused.status).toBe(429);
  });

  it('frees a slot when a connection closes', async () => {
    // The cap is still full from the previous test — this asserts the teardown
    // path actually releases, which is what stops the cap becoming permanent
    // for a user who merely reconnected a lot (FR-027).
    expect((await connect(token)).status).toBe(429);

    const victim = open.find((c) => c.status === 200);
    victim?.close();
    await new Promise((r) => setTimeout(r, 300));

    expect((await connect(token)).status).toBe(200);
  });

  it('caps each user independently', async () => {
    // A different user must be unaffected by the first one being at its cap —
    // otherwise one noisy client would deny service to everyone (FR-028).
    const other = await connect(otherToken);
    expect(other.status).toBe(200);
  });
});
