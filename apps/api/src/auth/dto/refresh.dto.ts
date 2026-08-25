import { IsNotEmpty, IsString } from 'class-validator';

export class RefreshDto {
  // snake_case to match the wire body exactly (contracts/api.md).
  @IsString()
  @IsNotEmpty()
  refresh_token!: string;
}
