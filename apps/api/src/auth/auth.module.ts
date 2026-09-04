import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RawUploadSchema, RefreshToken, User } from '@workout-logging/shared';
import { RedisModule } from '../redis/redis.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthTokensService } from './auth-tokens.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([RefreshToken, User]),
    // Account deletion (FR-021) reaches into Mongo (raw_uploads + GridFS images)
    // and Redis (rate-limit counters, weekly-volume hashes) too. The TypeORM
    // DataSource / Mongoose Connection come from the global forRoot in AppModule;
    // forFeature registers the RawUpload schema on that connection.
    MongooseModule.forFeature([{ name: 'RawUpload', schema: RawUploadSchema }]),
    RedisModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: '15m' }, // research.md #6
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthTokensService, AuthService, JwtAuthGuard],
  exports: [AuthTokensService, AuthService, JwtAuthGuard],
})
export class AuthModule {}
