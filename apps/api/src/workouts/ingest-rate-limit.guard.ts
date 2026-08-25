import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { checkIngestRateLimit } from '@workout-logging/shared';
import type { Redis } from 'ioredis';
import { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { REDIS_CLIENT } from '../redis/redis.module';

// FR-018: ingestion rate-limited to 30 requests/minute/user. Must run after
// JwtAuthGuard — needs request.userId already set.
@Injectable()
export class IngestRateLimitGuard implements CanActivate {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const { allowed } = await checkIngestRateLimit(this.redis, request.userId);
    if (!allowed) {
      throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
