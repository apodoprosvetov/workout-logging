import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Connection, Model } from 'mongoose';
import { DataSource, Repository } from 'typeorm';

import {
  deleteWorkoutImages,
  getWorkoutImagesBucket,
  ingestRateLimitKey,
  isUniqueViolation,
  logLine,
  RawUploadDocument,
  User,
  weeklyVolumeRedisKeyPattern,
} from '@workout-logging/shared';

import { AuthTokensService } from './auth-tokens.service';
import { REDIS_CLIENT } from '../redis/redis.module';

import type Redis from 'ioredis';

export interface AuthTokenResponse {
  access_token: string;
  refresh_token: string;
}

export interface RegisterResult extends AuthTokenResponse {
  user: { id: string; email: string };
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly userRepository: Repository<User>,
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectModel('RawUpload') private readonly rawUploadModel: Model<RawUploadDocument>,
    @InjectConnection() private readonly mongoConnection: Connection,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly authTokensService: AuthTokensService,
  ) {}

  async register(email: string, password: string): Promise<RegisterResult> {
    const passwordHash = await this.authTokensService.hashPassword(password);

    let user: User;
    try {
      user = await this.userRepository.save(this.userRepository.create({ email, passwordHash }));
    } catch (err) {
      // The insert is the real check — catches the register/register race too, not just a
      // pre-existing duplicate (a findOneBy-then-insert pre-check would leave that race open).
      if (isUniqueViolation(err)) {
        throw new ConflictException('email already registered');
      }
      throw err;
    }

    return {
      access_token: this.authTokensService.issueAccessToken(user.id),
      refresh_token: await this.authTokensService.issueRefreshToken(user.id),
      user: { id: user.id, email: user.email },
    };
  }

  async login(email: string, password: string): Promise<AuthTokenResponse> {
    const user = await this.userRepository.findOneBy({ email });
    if (!user) {
      throw new UnauthorizedException('invalid email or password');
    }

    const passwordMatches = await this.authTokensService.verifyPassword(
      user.passwordHash,
      password,
    );
    if (!passwordMatches) {
      throw new UnauthorizedException('invalid email or password');
    }

    return {
      access_token: this.authTokensService.issueAccessToken(user.id),
      refresh_token: await this.authTokensService.issueRefreshToken(user.id),
    };
  }

  async refresh(refreshToken: string): Promise<AuthTokenResponse> {
    const rotated = await this.authTokensService.rotateRefreshToken(refreshToken);
    if (!rotated) {
      throw new UnauthorizedException('refresh token invalid, expired, or revoked');
    }

    return {
      access_token: this.authTokensService.issueAccessToken(rotated.userId),
      refresh_token: rotated.refreshToken,
    };
  }

  // FR-021 / data-model.md "Account Deletion": erase the user and every trace of
  // their data across all three stores. Ordered so a partial failure converges
  // on a retry — every step is idempotent (re-deleting already-gone rows/keys is
  // a no-op) and safe to repeat:
  //
  //   1. Postgres, in one transaction: children before parents (all FKs are
  //      ON DELETE NO ACTION), ending with the `users` row. If this throws,
  //      nothing else has been touched yet and the account still exists.
  //   2. MongoDB: the GridFS image bytes (usually already gone — transient,
  //      research.md #11 — hence best-effort), then the `raw_uploads` docs.
  //   3. Redis: the caller's ingest rate-limit counter and every weekly-volume hash.
  //
  // The `exercise_catalog` / shared `exercises` rows are never user-owned and
  // are left alone.
  async deleteAccount(userId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `DELETE FROM sets WHERE workout_exercise_id IN (
           SELECT we.id FROM workout_exercises we
           JOIN workouts w ON w.id = we.workout_id
           WHERE w.user_id = $1)`,
        [userId],
      );
      await manager.query(
        `DELETE FROM workout_exercises WHERE workout_id IN (SELECT id FROM workouts WHERE user_id = $1)`,
        [userId],
      );
      await manager.query(`DELETE FROM workouts WHERE user_id = $1`, [userId]);
      await manager.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [userId]);
      await manager.query(`DELETE FROM users WHERE id = $1`, [userId]);
    });

    const rawUploads = await this.rawUploadModel
      .find({ user_id: userId }, { image_refs: 1 })
      .lean();
    const imageRefs = rawUploads.flatMap((doc) => doc.image_refs ?? []);
    if (imageRefs.length > 0) {
      await deleteWorkoutImages(getWorkoutImagesBucket(this.mongoConnection), imageRefs);
    }
    await this.rawUploadModel.deleteMany({ user_id: userId });

    const weeklyVolumeKeys = await this.scanKeys(weeklyVolumeRedisKeyPattern(userId));
    await this.redis.del(ingestRateLimitKey(userId), ...weeklyVolumeKeys);

    logLine('api', 'info', 'account deleted', {
      context: 'AuthService',
      userId,
      images: imageRefs.length,
      weeklyHashes: weeklyVolumeKeys.length,
    });
  }

  // Cursor-based SCAN (never KEYS — that blocks Redis) for every key matching a
  // glob. Fine at this project's scale: a user has at most ~1 hash per week.
  private async scanKeys(pattern: string): Promise<string[]> {
    const found: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      found.push(...batch);
    } while (cursor !== '0');
    return found;
  }
}
