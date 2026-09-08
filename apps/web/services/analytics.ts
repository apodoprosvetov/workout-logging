// HTTP operations against apps/api's /analytics routes. Follows the extension
// contract documented at the top of services/workouts.ts.
//
// Distinct from lib/analytics.ts, which holds the response types and the pure
// ISO-week maths (`isoWeekKey`, `weekRangeForOffset`). At the import site the
// alias keeps them apart: `@services/analytics` calls the API,
// `@lib/analytics` computes and describes.

import { apiJson } from './api-client';
import type { WeeklyVolumeResponse } from '@lib/analytics';

/**
 * GET /analytics/weekly-volume — training volume per muscle group for one ISO
 * week.
 *
 * `week` is a `YYYY-Www` key, as produced by `weekKeyForOffset` in
 * lib/analytics.ts. Note this endpoint takes a week *key*, not the
 * `[after, before)` date window `GET /workouts` takes — the two describe the
 * same week through different parameters, and `packages/shared`'s `isoWeekKey`
 * remains the single definition of where a week begins (specs/003 research #9).
 *
 * Throws ApiError on any non-2xx; there is no "no such week" — a week with no
 * training returns an empty `volumes` array.
 */
export async function getWeeklyVolume(week: string): Promise<WeeklyVolumeResponse> {
  const params = new URLSearchParams({ week });
  return apiJson<WeeklyVolumeResponse>(`/analytics/weekly-volume?${params}`);
}
