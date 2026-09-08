import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

import { NormalizeEmail } from '../../common/normalize-email.decorator';

export class RegisterDto {
  // 254 = RFC 5321 max envelope length; also caps unbounded input.
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  // MaxLength guards against argon2 hashing a pathologically large string
  // (a cheap DoS) — 200 is far above any real passphrase.
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  password!: string;
}
