import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ExerciseCatalogSchema } from '@workout-logging/shared';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

@Module({
  // TypeORM DataSource + Mongoose Connection come from the global core modules
  // (TypeOrmModule/MongooseModule.forRoot in AppModule). forFeature registers
  // the ExerciseCatalog schema on that connection so computeWeeklyVolume's
  // `connection.model('ExerciseCatalog')` resolves (the worker registers it via
  // its own factory; apps/api hadn't needed it before). AuthModule is needed so
  // JwtAuthGuard's AuthTokensService resolves in this module's DI subtree.
  imports: [
    MongooseModule.forFeature([{ name: 'ExerciseCatalog', schema: ExerciseCatalogSchema }]),
    RedisModule,
    AuthModule,
  ],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
