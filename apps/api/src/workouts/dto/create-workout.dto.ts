import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

import { MAX_WORKOUT_IMAGES } from '@workout-logging/shared';

// Multipart body (contracts/api.md): text?, images? (file[], max
// MAX_WORKOUT_IMAGES), performed_at?. "At least one of text/images required"
// is enforced in IngestionService (data-model.md: "enforced at the ingestion
// endpoint, not just at write time"), not duplicated here as cross-field
// DTO validation.
export class CreateWorkoutDto {
  // No per-image size limit in the MVP (spec.md Q4), but free text is bounded:
  // 50k chars is ~10k words — orders of magnitude past any real workout log,
  // while still stopping a pathological blob from reaching Mongo and DeepSeek.
  @IsOptional()
  @IsString()
  @MaxLength(50_000)
  text?: string;

  @IsOptional()
  @IsISO8601()
  performed_at?: string;

  // @fastify/multipart (keyValues mode) hands repeated `images` parts to us
  // as an array of Buffers, but a *single* one as a bare Buffer (not a
  // 1-element array) — normalize to always-array here so nothing downstream
  // has to special-case the single-image submission.
  //
  // Also drop non-Buffer / zero-length entries: an `images` field sent empty
  // (a plain text part `images=`, or a 0-byte file) would otherwise survive as
  // `['']` / `[<Buffer 0>]`, making IngestionService's `hasImage` true and
  // writing a junk GridFS object. Collapse "nothing usable" back to undefined
  // so it reads as text-only; the existing text-or-image 400 still fires when
  // both end up empty.
  @IsOptional()
  @Transform(({ value }): Buffer[] | undefined => {
    if (value === undefined || value === null) return undefined;
    const arr = Array.isArray(value) ? value : [value];
    const buffers = arr.filter((v): v is Buffer => Buffer.isBuffer(v) && v.length > 0);
    return buffers.length > 0 ? buffers : undefined;
  })
  @ArrayMaxSize(MAX_WORKOUT_IMAGES)
  images?: Buffer[];
}
