import 'reflect-metadata';
import multipart from '@fastify/multipart';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { registerRequestLogging } from './common/request-logging';
import { StructuredLogger } from './common/structured-logger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    bufferLogs: true,
  });

  // Route every Nest log (services, bootstrap, lifecycle) through the shared
  // structured JSON logger (T052). bufferLogs above holds the early lines until
  // this is set so nothing bypasses it.
  app.useLogger(new StructuredLogger());

  // apps/web (T035) runs on a different origin/port and calls this API
  // directly from the browser via fetch — without this, every request 404s
  // on its CORS preflight (no Bearer-cookie credentials involved, so no
  // `credentials: true` needed; tokens travel in the Authorization header).
  // `methods` must be listed explicitly: under the Fastify adapter enableCors
  // only advertises the CORS-safelisted methods (GET/HEAD/POST) by default, so
  // a DELETE/PUT/PATCH preflight is rejected in the browser (curl skips the
  // preflight, which is why it "works" there).
  const webOrigin = app.get(ConfigService).get<string>('WEB_ORIGIN') ?? 'http://localhost:3001';
  app.enableCors({
    origin: webOrigin,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });

  // Adds prefix to all controllers
  app.setGlobalPrefix('api');

  // keyValues: text fields become plain values, files become Buffers, directly
  // on request.body — lets POST /workouts use a normal class-validator DTO.
  await app.register(multipart, { attachFieldsToBody: 'keyValues' });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  registerRequestLogging(app);

  // Without this, Nest never runs onModuleDestroy in a real process — the hooks
  // only fire on an explicit app.close(), which nothing calls here. Deploys
  // restart api-1 then api-2 by SIGTERM (README, "Deploy"), so every rolling
  // release would otherwise kill the process mid-flight: Redis and RabbitMQ
  // connections dropped rather than closed, and open SSE streams severed
  // instead of completing. Clients recover either way (FR-022), but a stream
  // that ends cleanly costs the client one reconnect less.
  app.enableShutdownHooks();

  const port = app.get(ConfigService).get<number>('PORT') ?? 3000;
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
