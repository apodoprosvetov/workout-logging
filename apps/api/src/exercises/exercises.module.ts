import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { ExerciseCatalogSchema } from '@workout-logging/shared';

import { ExercisesController } from './exercises.controller';
import { ExercisesService } from './exercises.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  // Same wiring as AnalyticsModule/WorkoutsModule: forFeature registers the
  // schema on the global connection so `connection.model('ExerciseCatalog')`
  // resolves here, and AuthModule makes JwtAuthGuard's AuthTokensService
  // resolvable in this module's own DI subtree.
  imports: [
    MongooseModule.forFeature([{ name: 'ExerciseCatalog', schema: ExerciseCatalogSchema }]),
    AuthModule,
  ],
  controllers: [ExercisesController],
  providers: [ExercisesService],
})
export class ExercisesModule {}
