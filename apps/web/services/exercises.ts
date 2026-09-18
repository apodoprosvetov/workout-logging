// HTTP operations against /exercises. Follows the extension contract
// documented at the top of services/workouts.ts; `@lib/contracts/exercises`
// holds the type.

import { apiJson } from './api-client';

import type { ExerciseCatalogEntry } from '@lib/contracts/exercises';

/**
 * How long the catalog may take before the caller gives up on it.
 *
 * Not arbitrary: with MongoDB unreachable the endpoint answers 503 only after
 * the driver's 30s server-selection timeout — measured. Suggestions are
 * optional, so waiting that long buys nothing; the editor is required to stay
 * usable without them.
 */
const CATALOG_TIMEOUT_MS = 3000;

/**
 * Fetched once per tab and shared. The catalog is reference data that does not
 * change between page views, and the editor asks for it on every keystroke's
 * render — a request per ask would be pure waste.
 *
 * The promise is cached, not the value, so concurrent callers await one
 * request. A rejection clears it, so a failure is retried by the next caller
 * rather than cached as "no catalog" for the life of the tab.
 */
let catalog: Promise<ExerciseCatalogEntry[]> | null = null;

/**
 * GET /exercises — the whole catalog, ordered by name.
 *
 * Throws on failure, including a timeout, like every other function here.
 * Callers offering suggestions are expected to treat that as "no suggestions",
 * never as a reason to block editing.
 */
export async function listExercises(): Promise<ExerciseCatalogEntry[]> {
  catalog ??= apiJson<ExerciseCatalogEntry[]>('/exercises', {
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  }).catch((error: unknown) => {
    catalog = null;
    throw error;
  });

  return catalog;
}
