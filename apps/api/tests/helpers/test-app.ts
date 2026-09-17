import 'reflect-metadata';
import path from 'node:path';

import multipart from '@fastify/multipart';
import { ModuleMetadata, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  createTypeOrmDataSource,
  mongoUri,
  typeOrmDataSourceOptions,
} from '@workout-logging/shared';

import { AllExceptionsFilter } from '../../src/common/all-exceptions.filter';
import { OutboxRelayService } from '../../src/events/outbox-relay.service';

// Shared harness for contract/integration tests: boots a real Nest+Fastify app
// wired the same way apps/api/src/main.ts does (ValidationPipe, exception filter),
// against the live Postgres/MongoDB from docker-compose — per plan.md's testing
// philosophy (no mocking the databases). Callers pass whichever feature module(s)
// they're testing; ConfigModule + TypeOrmModule + MongooseModule are included here
// since most features touch at least one of Postgres/Mongo.
export async function createTestApp(
  imports: NonNullable<ModuleMetadata['imports']>,
): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ envFilePath: path.resolve(__dirname, '../../../../.env') }),
      TypeOrmModule.forRoot(typeOrmDataSourceOptions),
      MongooseModule.forRoot(mongoUri),
      ...imports,
    ],
  }).compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('api');
  await app.register(multipart, { attachFieldsToBody: 'keyValues' });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  // Stop the outbox relay in every test app.
  //
  // Any spec importing EventsModule (directly, or via WorkoutsModule) starts a
  // relay loop that sweeps the shared `outbox` table once a second and
  // publishes whatever it finds — including rows another spec file inserted and
  // is about to assert on. Vitest runs spec files in parallel, so that turned
  // into a genuine cross-file flake: the relay suite failed roughly one full
  // run in three, and never when run alone.
  //
  // Stopping it here rather than in each spec is deliberate — the next contract
  // test that happens to import EventsModule would otherwise reintroduce the
  // flake silently. No contract test asserts on relay behaviour; the one suite
  // that does drives `sweepOnce()` by hand.
  // try/catch, not `{ optional: true }`: that flag governs *injection*, not
  // `app.get`, which throws for a provider the graph does not contain — and
  // most specs here import neither EventsModule nor WorkoutsModule.
  try {
    await app.get(OutboxRelayService, { strict: false }).onModuleDestroy();
  } catch {
    // No relay in this module graph; nothing to stop.
  }

  return app;
}

// supertest binds to a raw http.Server; Fastify only exposes `.server` after `.ready()`.
export function httpServer(app: NestFastifyApplication): unknown {
  return app.getHttpAdapter().getInstance().server;
}

// Generates a unique, easily-greppable test email and tracks it for cleanup.
export function testEmailFactory(prefix: string): {
  next: (label: string) => string;
  all: () => string[];
} {
  const emails: string[] = [];
  return {
    next(label: string) {
      const email = `${prefix}-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
      emails.push(email);
      return email;
    },
    all() {
      return emails;
    },
  };
}

// Deletes users (and their refresh_tokens, via FK) created by a test run.
export async function deleteTestUsers(emails: string[]): Promise<void> {
  if (emails.length === 0) return;
  const ds = createTypeOrmDataSource();
  await ds.initialize();
  await ds.query(
    'DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email = ANY($1))',
    [emails],
  );
  await ds.query('DELETE FROM users WHERE email = ANY($1)', [emails]);
  await ds.destroy();
}
