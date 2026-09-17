// HTTP operations against apps/api's /analytics routes. Follows the extension
// contract documented at the top of services/workouts.ts.
//
// Distinct from the two files this one sits between: `@lib/contracts/analytics`
// describes the response shape, `@lib/weeks` computes the ISO week to ask for,
// and only this file talks to the network.

import { apiJson } from './api-client';

import type { WeeklyVolumeResponse } from '@lib/contracts/analytics';

/**
 * GET /analytics/weekly-volume — training volume per muscle group for one ISO
 * week.
 *
 * `week` is a `YYYY-Www` key, as produced by `weekKeyForOffset` in
 * lib/weeks.ts. Note this endpoint takes a week *key*, not the
 * `[after, before)` date window `GET /workouts` takes — the two describe the
 * same week through different parameters, and `packages/shared`'s `isoWeekKey`
 * remains the single definition of where a week begins (docs/specs-archive/003 research #9).
 *
 * Throws ApiError on any non-2xx; there is no "no such week" — a week with no
 * training returns an empty `volumes` array.
 */
export async function getWeeklyVolume(week: string): Promise<WeeklyVolumeResponse> {
  const params = new URLSearchParams({ week });
  return apiJson<WeeklyVolumeResponse>(`/analytics/weekly-volume?${params}`);
}
