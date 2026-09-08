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
