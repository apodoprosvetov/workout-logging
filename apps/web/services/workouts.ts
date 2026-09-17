// HTTP operations against /workouts. The IO half; `@lib/contracts/workouts`
// holds the types (plan.md: services/ for IO, lib/ for pure helpers).
//
// Conventions for new functions here, so callers can predict one unread:
//   1. One async function per API operation, named for it.
//   2. Plain arguments — building the query string is this module's job.
//   3. Resolves with the parsed body, or void.
//   4. Throws ApiError; callers never inspect status codes.
//   5. A non-2xx treated as success is documented on that function, with why.
//
// apiFetch already handles auth, refresh and retry — nothing here touches tokens.

import { ApiError, apiFetch, apiJson } from './api-client';

import type { WorkoutDetail, WorkoutListResponse, WorkoutStatus } from '@lib/contracts/workouts';

/**
 * Mirrors `GET /workouts` (contracts/api.md). Omitting `page`/`per_page` means
 * page 1 at the API's default of 20.
 *
 * `before`/`after` are filters, not pagination: a half-open `[after, before)`
 * window over `performed_at` — pass both for one week.
 */
export interface ListWorkoutsQuery {
  status?: WorkoutStatus[];
  page?: number;
  per_page?: number;
  /** ISO 8601. Exclusive upper bound on `performed_at`. */
  before?: string;
  /** ISO 8601. Inclusive lower bound on `performed_at`. */
  after?: string;
}

/**
 * GET /workouts — a page or window, newest first. Knows nothing about page
 * sizes or over-fetching: those policies differ between the history list and
 * the dashboard's week view, and belong to the caller.
 */
export async function listWorkouts(query: ListWorkoutsQuery = {}): Promise<WorkoutListResponse> {
  const params = new URLSearchParams();
  if (query.status?.length) {
    for (const st of query.status) {
      params.append('status', st);
    }
  }
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.per_page !== undefined) params.set('per_page', String(query.per_page));
  if (query.before) params.set('before', query.before);
  if (query.after) params.set('after', query.after);

  const search = params.toString();
  return apiJson<WorkoutListResponse>(search ? `/workouts?${search}` : '/workouts');
}

/** What `POST /workouts` answers — the workout exists, parsing has not run yet. */
export interface CreatedWorkout {
  workout_id: string;
  status: WorkoutStatus;
  /**
   * Where the workout landed: the supplied date, or the server's default — read
   * it rather than recomputing, that default is the server's to decide. It can
   * still move later if the parser finds a date in the text.
   */
  performed_at: string;
}

/** POST /workouts. FormData because multipart is the endpoint's contract. */
export async function createWorkout(body: FormData): Promise<CreatedWorkout> {
  return apiJson<CreatedWorkout>('/workouts', { method: 'POST', body });
}

/**
 * GET /workouts/:id, or `null` when there is nothing to show.
 *
 * Null rather than a thrown 404 (rule 4): the endpoint answers 404 both for a
 * missing id and for another user's workout — never confirming someone else's
 * data — and the caller cannot act on the two differently.
 */
export async function getWorkout(id: string): Promise<WorkoutDetail | null> {
  try {
    return await apiJson<WorkoutDetail>(`/workouts/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * DELETE /workouts/:id. **404 counts as success** — the caller's goal already
 * holds either way, and failing would make a double-click look like an error.
 */
export async function deleteWorkout(id: string): Promise<void> {
  const response = await apiFetch(`/workouts/${id}`, { method: 'DELETE' });
  if (response.ok || response.status === 404) return;

  const body: unknown = await response.json().catch(() => undefined);
  throw new ApiError(response.status, body);
}
