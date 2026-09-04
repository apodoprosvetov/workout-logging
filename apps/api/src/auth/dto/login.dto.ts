import { IsEmail, IsString, MaxLength } from 'class-validator';
import { NormalizeEmail } from '../../common/normalize-email.decorator';

export class LoginDto {
  // Same normalization as RegisterDto — must match exactly or a mixed-case
  // address won't resolve to the account it created.
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MaxLength(200)
  password!: string;
}
