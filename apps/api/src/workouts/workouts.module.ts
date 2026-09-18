import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ExerciseCatalogSchema, RawUploadSchema, Workout } from '@workout-logging/shared';

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
    MongooseModule.forFeature([
      { name: 'RawUpload', schema: RawUploadSchema },
      // Needed for replaceById's `connection.model('ExerciseCatalog')`, as in
      // AnalyticsModule. Missing, it throws MissingSchemaError, which
      // replaceById's catch would report as a 503 and hide the wiring bug.
      { name: 'ExerciseCatalog', schema: ExerciseCatalogSchema },
    ]),
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
