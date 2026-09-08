// HTTP operations against apps/api's /workouts routes.
//
// Distinct from lib/workouts.ts, which holds the contract *types* and pure
// formatters — this is the IO half (plan.md: services/ for IO clients, lib/ for
// pure helpers and types). At the import site the alias keeps them apart:
// `@services/workouts` calls the API, `@lib/workouts` describes its shapes.
//
// Extension contract — follow it when adding listWorkouts, getWorkout,
// createWorkout and the rest, so callers can predict a new function without
// reading it:
//
//   1. One exported async function per API operation, named for the operation.
//   2. Plain arguments in — never a Response, a Headers or a URLSearchParams.
//      Building the query string is this module's job, not the caller's.
//   3. Resolves with the parsed body, or void when the endpoint returns none.
//   4. Throws ApiError (from ./api-client) on anything the caller must handle.
//      Callers never inspect status codes; that knowledge stays here.
//   5. Any non-2xx status deliberately treated as success is documented on the
//      function that does it, with the reason.
//
// Auth, token refresh and retry are already handled underneath by apiFetch —
// nothing here should touch tokens.

import { ApiError, apiFetch, apiJson } from './api-client';

import type { WorkoutDetail, WorkoutListResponse, WorkoutStatus } from '@lib/workouts';

/**
 * Query for {@link listWorkouts}, mirroring `GET /workouts` in contracts/api.md.
 *
 * `page`/`per_page` are the pagination; every list endpoint takes the same two
 * and answers in the same envelope. Omitting them means page 1 at the API's
 * default page size of 20.
 *
 * `before` (exclusive) and `after` (inclusive) are *filters*, not pagination:
 * they bound `performed_at` as a half-open `[after, before)` window — pass both
 * to fetch a single week.
 */
export interface ListWorkoutsQuery {
  status?: WorkoutStatus;
  page?: number;
  per_page?: number;
  /** ISO 8601. Exclusive upper bound on `performed_at`. */
  before?: string;
  /** ISO 8601. Inclusive lower bound on `performed_at`. */
  after?: string;
}

/**
 * GET /workouts — the caller's page or window of workouts, newest first.
 *
 * Deliberately not clever: it does not know about page sizes, cursors or
 * over-fetching. Those are policies of whoever is paginating, and they differ
 * between the history list and the dashboard's week view. This function's whole
 * job is turning a typed query into a request.
 */
export async function listWorkouts(query: ListWorkoutsQuery = {}): Promise<WorkoutListResponse> {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
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
   * The date the workout was stored under: the one supplied, or the one the
   * server chose when none was. Read it rather than recomputing — the default
   * is the server's to decide (contracts/api.md).
   *
   * It can still move: when no date was supplied, the parser may later replace
   * it with one found in the text. This is where the workout landed now.
   */
  performed_at: string;
}

/**
 * POST /workouts — hand raw text and/or images to the parsing pipeline.
 *
 * Takes the already-built FormData because the file inputs live in the form;
 * multipart is the endpoint's contract (@fastify/multipart), so there is no
 * JSON shape to accept instead.
 */
export async function createWorkout(body: FormData): Promise<CreatedWorkout> {
  return apiJson<CreatedWorkout>('/workouts', { method: 'POST', body });
}

/**
 * GET /workouts/:id — one workout with its exercises and sets, or `null` when
 * there is no such workout to show.
 *
 * Null rather than a thrown 404, so callers never touch status codes (rule 4
 * above). "Not found" is an ordinary outcome this screen renders, not a
 * failure: the endpoint answers 404 both for an id that does not exist and for
 * another user's workout (contracts/api.md — never confirm the existence of
 * someone else's data), and the caller can act on neither differently. Every
 * other non-2xx still throws ApiError.
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
 * DELETE /workouts/:id — resolves once the workout is gone.
 *
 * 404 counts as success. The endpoint answers 404 both for a workout that never
 * existed and for one belonging to another user (contracts/api.md: never
 * confirm the existence of someone else's data), and in either case the
 * caller's goal — "this row should not be there" — already holds. Reporting it
 * as a failure would make a double-click look like an error.
 */
export async function deleteWorkout(id: string): Promise<void> {
  const response = await apiFetch(`/workouts/${id}`, { method: 'DELETE' });
  if (response.ok || response.status === 404) return;

  const body: unknown = await response.json().catch(() => undefined);
  throw new ApiError(response.status, body);
}
