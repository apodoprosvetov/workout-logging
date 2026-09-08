import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';
import { WorkoutStatus } from '@workout-logging/shared';

// Query params for GET /workouts (contracts/api.md): ?status=&limit=&before=&after=,
// sorted/paginated by performed_at desc. `after` (inclusive) + `before`
// (exclusive) form a half-open [after, before) window — e.g. one ISO week.
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

  @IsOptional()
  @IsISO8601()
  after?: string;
}
