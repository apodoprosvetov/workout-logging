import { ArrayMaxSize, IsISO8601, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';
import { MAX_WORKOUT_IMAGES } from '@workout-logging/shared';

// Multipart body (contracts/api.md): text?, images? (file[], max
// MAX_WORKOUT_IMAGES), performed_at?. "At least one of text/images required"
// is enforced in IngestionService (data-model.md: "enforced at the ingestion
// endpoint, not just at write time"), not duplicated here as cross-field
// DTO validation.
export class CreateWorkoutDto {
  @IsOptional()
  @IsString()
  text?: string;

  @IsOptional()
  @IsISO8601()
  performed_at?: string;

  // @fastify/multipart (keyValues mode) hands repeated `images` parts to us
  // as an array of Buffers, but a *single* one as a bare Buffer (not a
  // 1-element array) — normalize to always-array here so nothing downstream
  // has to special-case the single-image submission.
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? value : Array.isArray(value) ? value : [value]))
  @ArrayMaxSize(MAX_WORKOUT_IMAGES)
  images?: Buffer[];
}
