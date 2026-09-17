import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as argon2 from 'argon2';
import { Repository } from 'typeorm';

import { RefreshToken } from '@workout-logging/shared';

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (research.md #6)

export interface AccessTokenClaims {
  sub: string;
}
export interface AccessTokenPayload extends AccessTokenClaims {
  iat: number; // signed, unix seconds
  exp: number; // expired in, unix seconds
}

export interface RotatedRefreshToken {
  userId: string;
  refreshToken: string;
}

@Injectable()
export class AuthTokensService {
  constructor(
    private readonly jwtService: JwtService,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
  ) {}

  async hashPassword(password: string): Promise<string> {
    return argon2.hash(password);
  }

  async verifyPassword(passwordHash: string, password: string): Promise<boolean> {
    return argon2.verify(passwordHash, password);
  }

  issueAccessToken(userId: string): string {
    const payload: AccessTokenClaims = { sub: userId };
    return this.jwtService.sign(payload);
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    return this.jwtService.verify<AccessTokenPayload>(token);
  }

  // Raw token returned to the client is never stored — only its argon2 hash is
  // (research.md #6). The token's own row id doubles as a lookup selector,
  // since argon2's hash is salted and can't be looked up by re-hashing (see
  // research.md #6's "Refresh-token lookup" note).
  async issueRefreshToken(userId: string): Promise<string> {
    const secret = randomBytes(32).toString('hex');
    const tokenHash = await argon2.hash(secret);
    const refreshToken = await this.refreshTokenRepository.save(
      this.refreshTokenRepository.create({
        userId,
        tokenHash,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      }),
    );
    return `${refreshToken.id}.${secret}`;
  }

  // Verifies a raw refresh token and, if valid, revokes it and issues its
  // replacement (rotation, research.md #6). Null if invalid/expired/revoked/reused.
  async rotateRefreshToken(rawToken: string): Promise<RotatedRefreshToken | null> {
    const [id, secret] = rawToken.split('.');
    if (!id || !secret) return null;

    const existing = await this.refreshTokenRepository.findOneBy({ id });
    if (!existing || existing.revokedAt || existing.expiresAt < new Date()) return null;

    const valid = await argon2.verify(existing.tokenHash, secret);
    if (!valid) return null;

    existing.revokedAt = new Date();
    await this.refreshTokenRepository.save(existing);

    return { userId: existing.userId, refreshToken: await this.issueRefreshToken(existing.userId) };
  }
}
