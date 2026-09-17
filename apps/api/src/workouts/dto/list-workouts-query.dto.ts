import { Transform } from 'class-transformer';
import { IsArray, IsEnum, IsISO8601, IsOptional } from 'class-validator';

import { WorkoutStatus } from '@workout-logging/shared';

import { PaginationQueryDto } from '../../common/pagination.dto';

// Query params for GET /workouts (contracts/api.md):
// ?status=&before=&after=&page=&per_page=, sorted by performed_at desc.
//
// `page`/`per_page` come from PaginationQueryDto and mean the same here as on
// every other list route. `before` (exclusive) and `after` (inclusive) are
// filters, not pagination: they bound performed_at as a half-open
// [after, before) window — pass both to fetch a single ISO week.
export class ListWorkoutsQueryDto extends PaginationQueryDto {
  @Transform(({ value }) => {
    if (value === '') {
      return [];
    }
    return value === undefined ? undefined : [...new Set([value].flat())];
  })
  @IsOptional()
  @IsArray()
  @IsEnum(WorkoutStatus, { each: true })
  status?: WorkoutStatus[];

  @IsOptional()
  @IsISO8601()
  before?: string;

  @IsOptional()
  @IsISO8601()
  after?: string;
}
