import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { SetUnit } from '@workout-logging/shared';

// Full replacement: whatever the caller wants to keep must be present. Order is
// array position — an explicit `order` field is rejected by the global
// ValidationPipe's `forbidNonWhitelisted`.

export class ReplaceSetDto {
  // Not @IsPositive: a bodyweight set is legitimately 0 kg.
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  weight!: number;

  @IsInt()
  @Min(1)
  reps!: number;

  @IsEnum(SetUnit)
  unit!: SetUnit;
}

export class ReplaceExerciseDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReplaceSetDto)
  sets!: ReplaceSetDto[];
}

export class ReplaceWorkoutDto {
  // Omitted means the workout has no name; the service stores null.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string | null;

  @IsISO8601()
  performed_at!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ReplaceExerciseDto)
  exercises!: ReplaceExerciseDto[];
}
