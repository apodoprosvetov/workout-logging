import { Transform } from 'class-transformer';

// Canonicalises an email input BEFORE @IsEmail validates it and before the
// service ever sees it. Register and login must agree on the exact form —
// otherwise registering as `Foo@X.com` creates an account that `foo@x.com`
// can never log into (and vice-versa). Trim + lowercase covers it; a
// non-string is passed through untouched so @IsString/@IsEmail still report it.
export function NormalizeEmail(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  );
}
