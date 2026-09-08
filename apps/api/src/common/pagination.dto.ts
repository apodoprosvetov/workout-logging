import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const DEFAULT_PAGE = 1;
export const DEFAULT_PER_PAGE = 20;
export const MAX_PER_PAGE = 100;

/**
 * Query params every list endpoint accepts. Extend it rather than repeating the
 * two fields, so `page` and `per_page` mean and validate the same thing on
 * every route.
 *
 * A base class, not a `@Pagination()` param decorator: main.ts installs a
 * global `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })`, so
 * an inherited DTO is already parsed, coerced and validated. A custom decorator
 * would run outside that pipe and have to redo all three.
 *
 * Properties are snake_case because they are the wire format — the query string
 * is `?page=2&per_page=20`, matching the snake_case bodies the API already
 * returns (`performed_at`, `access_token`).
 */
export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  // Capped so one request cannot ask the database for an unbounded scan. 100 is
  // also what the dashboard's whole-week query needs, so the cap is not in the
  // way of any real caller.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PER_PAGE)
  per_page?: number;
}
