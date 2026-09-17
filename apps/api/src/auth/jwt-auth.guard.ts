import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { FastifyRequest } from 'fastify';

import { AuthTokensService } from './auth-tokens.service';

export interface AuthenticatedRequest extends FastifyRequest {
  userId: string;
  timeLeftInSeconds: number; // token experesIn, unix seconds
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token ? token : null;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly authTokensService: AuthTokensService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      throw new UnauthorizedException();
    }

    try {
      const payload = this.authTokensService.verifyAccessToken(token);
      const currentTimeInSeconds = Math.floor(Date.now() / 1000);

      request.userId = payload.sub;
      request.timeLeftInSeconds = payload.exp - currentTimeInSeconds;
    } catch {
      throw new UnauthorizedException();
    }

    return true;
  }
}
