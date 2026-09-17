import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRedisClient,
  getEventsChannelName,
  WorkoutStatus,
  WORKOUT_SETTLED_KEY,
  type ChangeNotification,
} from '@workout-logging/shared';

import { AuthModule } from '../../src/auth/auth.module';
import { EventsModule } from '../../src/events/events.module';
import { listenOnRandomPort, openSse, type SseConnection } from '../helpers/sse';
import { createTestApp, deleteTestUsers, httpServer, testEmailFactory } from '../helpers/test-app';

import type Redis from 'ioredis';

describe('GET /events — delivery and isolation (contract, per contracts/events.md)', () => {
  let app: NestFastifyApplication;
  let port: number;
  let redis: Redis;
  const emails = testEmailFactory('events-delivery');
  const password = 'correct horse battery staple';
  const open: SseConnection[] = [];

  let alice: { id: string; token: string };
  let bob: { id: string; token: string };

  beforeAll(async () => {
    app = await createTestApp([AuthModule, EventsModule]);
    port = await listenOnRandomPort(app);
    redis = createRedisClient();
    alice = await register('alice');
    bob = await register('bob');
  });

  afterAll(async () => {
    for (const c of open) c.close();
    // Let the teardowns reach the server before its Redis connection goes: a
    // close that lands after shutdown logs a harmless but noisy unsubscribe
    // failure, which would mask a real one.
    await new Promise((r) => setTimeout(r, 200));
    redis.disconnect();
    await app.close();
    await deleteTestUsers(emails.all());
  });

  async function register(label: string): Promise<{ id: string; token: string }> {
    const email = emails.next(label);
    const res = await request(httpServer(app)).post('/api/auth/register').send({ email, password });
    const body = res.body as { access_token: string; user: { id: string } };
    return { id: body.user.id, token: body.access_token };
  }

  async function connect(token: string): Promise<SseConnection> {
    const c = await openSse(port, token);
    open.push(c);
    expect(c.status).toBe(200);
    return c;
  }

  function notification(userId: string, eventId: string): ChangeNotification {
    return {
      type: WORKOUT_SETTLED_KEY,
      event_id: eventId,
      user_id: userId,
      occurred_at: new Date().toISOString(),
      workout_id: 'workout-' + eventId,
      status: WorkoutStatus.PARSED,
      performed_at: '2026-09-07T00:00:00.000Z',
    };
  }

  async function publish(userId: string, eventId: string): Promise<void> {
    await redis.publish(
      getEventsChannelName(userId),
      JSON.stringify(notification(userId, eventId)),
    );
  }

  it('delivers a published notification to the owner as an SSE frame', async () => {
    const stream = await connect(alice.token);
    await publish(alice.id, 'evt-owner');

    await stream.waitFor('evt-owner');
    // The SSE event name mirrors the envelope's `type` (contracts/api.md).
    expect(stream.text).toContain(`event: ${WORKOUT_SETTLED_KEY}`);
    expect(stream.text).toContain('"status":"parsed"');
    expect(stream.text).toContain('"performed_at":"2026-09-07T00:00:00.000Z"');
  });

  it('delivers to every stream the same user has open', async () => {
    const first = await connect(alice.token);
    const second = await connect(alice.token);

    await publish(alice.id, 'evt-fanout');

    await first.waitFor('evt-fanout');
    await second.waitFor('evt-fanout');
  });

  it('never leaks one user’s notification to another (FR-005, SC-011)', async () => {
    const aliceStream = await connect(alice.token);
    const bobStream = await connect(bob.token);

    await publish(alice.id, 'evt-secret');
    await aliceStream.waitFor('evt-secret');

    // Asserted on the raw stream, not on rendered state: a notification that
    // arrives and is filtered client-side would still be a breach. The channel
    // is the authorization boundary, so nothing about Alice may appear here.
    const bobText = await bobStream.settle(400);
    expect(bobText).not.toContain('evt-secret');
    expect(bobText).not.toContain(alice.id);
  });

  it('survives a malformed payload and keeps delivering', async () => {
    const stream = await connect(alice.token);

    // One handler serves every stream on this replica — an uncaught parse error
    // would stop delivery for everyone, not just this message.
    await redis.publish(getEventsChannelName(alice.id), '{ not json');
    await publish(alice.id, 'evt-after-garbage');

    await stream.waitFor('evt-after-garbage');
  });

  it('ignores a notification published to a channel that is not ours', async () => {
    const stream = await connect(alice.token);

    await redis.publish('weekly_volume:' + alice.id + ':2026-W37', 'evt-wrong-channel');
    await publish(alice.id, 'evt-right-channel');

    await stream.waitFor('evt-right-channel');
    expect(stream.text).not.toContain('evt-wrong-channel');
  });
});
