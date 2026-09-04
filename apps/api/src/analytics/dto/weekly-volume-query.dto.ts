import { IsOptional, Matches } from 'class-validator';

// Query params for GET /analytics/weekly-volume (contracts/api.md):
// ?week=YYYY-Www (ISO week), defaults to the current week when omitted.
// Week number is constrained to 01-53 so a nonsense value like 2026-W00 or
// 2026-W99 is a clean 400 rather than a 200 with an empty result.
export class WeeklyVolumeQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/, {
    message: 'week must be an ISO week like 2026-W35',
  })
  week?: string;
}
