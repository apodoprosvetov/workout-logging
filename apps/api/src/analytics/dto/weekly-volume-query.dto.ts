import { IsOptional, Matches } from 'class-validator';

// Query params for GET /analytics/weekly-volume (contracts/api.md):
// ?week=YYYY-Www (ISO week), defaults to the current week when omitted.
export class WeeklyVolumeQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-W\d{2}$/, { message: 'week must be an ISO week like 2026-W35' })
  week?: string;
}
