import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken, User } from '@workout-logging/shared';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthTokensService } from './auth-tokens.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([RefreshToken, User]),
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
