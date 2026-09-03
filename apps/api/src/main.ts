import 'reflect-metadata';
import multipart from '@fastify/multipart';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());

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

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());

  const port = app.get(ConfigService).get<number>('PORT') ?? 3000;
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
