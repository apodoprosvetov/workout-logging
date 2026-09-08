import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HealthModule } from '../../src/health/health.module';
import { createTestApp, httpServer } from '../helpers/test-app';

// Unauthenticated on purpose (Caddy's active health check, infra/Caddyfile,
// research.md #7; the CloudWatch Synthetics canary, research.md #8) — no
// token, no DB fixtures needed for this one.
describe('GET /health (contract)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp([HealthModule]);
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with a status: ok body, no auth required', async () => {
    const res = await request(httpServer(app)).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
