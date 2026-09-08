import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RawUploadSchema, Workout } from '@workout-logging/shared';

import { IngestRateLimitGuard } from './ingest-rate-limit.guard';
import { IngestionService } from './ingestion.service';
import { WorkoutsController } from './workouts.controller';
import { WorkoutsService } from './workouts.service';
import { AuthModule } from '../auth/auth.module';
import { EventsModule } from '../events/events.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Workout]),
    MongooseModule.forFeature([{ name: 'RawUpload', schema: RawUploadSchema }]),
    EventsModule,
    RedisModule,
    // WorkoutsController's @UseGuards(JwtAuthGuard) needs AuthTokensService resolvable
    // in this module's own DI subtree — Nest modules don't share providers with
    // siblings under AppModule automatically, only via explicit imports.
    AuthModule,
  ],
  controllers: [WorkoutsController],
  providers: [IngestionService, IngestRateLimitGuard, WorkoutsService],
  exports: [IngestionService],
})
export class WorkoutsModule {}
