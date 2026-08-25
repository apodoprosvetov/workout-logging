import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';
import { WorkoutStatus } from '@workout-logging/shared';

// Query params for GET /workouts (contracts/api.md): ?status=&limit=&before=,
// pagination by created_at.
export class ListWorkoutsQueryDto {
  @IsOptional()
  @IsEnum(WorkoutStatus)
  status?: WorkoutStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsISO8601()
  before?: string;
}
