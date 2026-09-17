import path from 'node:path';

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { TypeOrmModule } from '@nestjs/typeorm';

import { mongoUri, typeOrmDataSourceOptions } from '@workout-logging/shared';

import { AnalyticsModule } from './analytics/analytics.module';
import { AuthModule } from './auth/auth.module';
import { EventsModule } from './events/events.module';
import { HealthModule } from './health/health.module';
import { WorkoutsModule } from './workouts/workouts.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: path.resolve(__dirname, '..', '..', '.env'),
    }),
    TypeOrmModule.forRoot(typeOrmDataSourceOptions),
    MongooseModule.forRoot(mongoUri),
    AuthModule,
    WorkoutsModule,
    HealthModule,
    AnalyticsModule,
    EventsModule,
  ],
})
export class AppModule {}
