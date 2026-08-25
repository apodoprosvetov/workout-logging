import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation, User } from '@workout-logging/shared';
import { Repository } from 'typeorm';
import { AuthTokensService } from './auth-tokens.service';

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

    const passwordMatches = await this.authTokensService.verifyPassword(user.passwordHash, password);
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
}
