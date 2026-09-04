import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RefreshDto {
  // snake_case to match the wire body exactly (contracts/api.md).
  // The real token is `{uuid}.{64 hex}` (~101 chars, research.md #6) — 512
  // leaves generous headroom while rejecting junk payloads outright.
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  refresh_token!: string;
}
