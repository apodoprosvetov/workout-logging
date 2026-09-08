# Data Model: Web Shell & Weekly Dashboard

**Feature**: 003-web-shell-weekly-dashboard | **Date**: 2026-09-08

This feature introduces **no new persisted entity**. Spec 001's `workouts`,
`workout_exercises`, `sets`, `users` and the Mongo-side raw uploads are all
unchanged in shape. What follows is (a) the one storage change, (b) the
client-side view models the week view needs, and (c) the client-side signal
that carries a newly logged workout to whatever is on screen.

## 1. Persisted change: one index

The only schema change in the feature.

| | |
| --- | --- |
| **Table** | `workouts` |
| **Current** | `IDX_e6a14b328d153b3050dd0773af` on `("user_id", "performed_at")` |
| **New** | `IDX_92387870c24d346a135a8c45d6` on `("user_id", "performed_at", "id")` — ascending; see below |
| **Declared in** | `packages/shared/src/entities/workout.entity.ts` — the `@Index(['userId', 'performedAt'])` decorator gains `'id'` |
| **Applied by** | a new migration under `packages/shared/src/db/migrations/` |
| **Why** | the list's `ORDER BY` now ends in `id` to make it a total order; the index must carry that column so the sort is satisfied by the scan instead of added on top (research #2, #3) |

**Ascending, not DESC.** The ordering is uniformly descending, so Postgres reads
the btree backwards and needs no per-column direction. Measured with `EXPLAIN`
on the real table: the two-column index leaves an `Incremental Sort` above the
index scan; this one leaves a bare `Index Scan Backward`. A DESC index would
matter only for a mixed-direction `ORDER BY`, and TypeORM's `@Index` cannot
declare one — so it would also put the entity permanently out of step with the
schema.

`synchronize` is false in this project, so the migration is the only thing
that changes the database — and it runs on every deploy already (spec 002's
`deploy.yml`). Down-migration restores the two-column index.

No column is added, removed, or retyped. No data is rewritten.

## 2. Client-side view models

These live in `apps/web` and exist only in memory. They are derived from the
HTTP contract, never from database rows — `apps/web` has no datastore access
(spec 001 plan.md).

### TrainingWeek

The unit of review on the dashboard. Derived, never fetched.

| Field | Type | Notes |
| --- | --- | --- |
| `weeksAgo` | integer | 0 = current week; the single piece of state the dashboard actually holds |
| `start` | Date | Monday 00:00:00 UTC of that ISO week |
| `end` | Date | Sunday of that week, used only for the range label |
| `isoKey` | string | `YYYY-Www`, the key `GET /analytics/weekly-volume` takes |

**Derivation**: `lib/analytics.ts` — `weekRangeForOffset(weeksAgo)` gives
`{start, end}`, `weekKeyForOffset(weeksAgo)` gives `isoKey`. All UTC
(research #9).

**Constraint**: `0 <= weeksAgo <= 12` (FR-003). The dashboard disables the
control at each end rather than clamping silently.

**Request window**: the half-open `[after, before)` pair sent to
`GET /workouts` is `after = start`, `before = start + 7 days`. Note that
`before` is derived from `start`, **not** from `end` — `end` is Sunday
00:00, so using it would drop every workout performed on the final day
(FR-005, and the reason acceptance scenario 6 of User Story 1 exists).

### WorkoutRow

What one row of any workout list shows. One definition, rendered by
`components/workout-table.tsx` for both the weekly list and the history list
(FR-024).

| Field | Type | Source |
| --- | --- | --- |
| `id` | string | `GET /workouts` |
| `name` | string \| null | rendered as "Untitled workout" when null |
| `status` | `pending` \| `parsed` \| `needs_review` \| `failed` | label and badge style from `lib/workouts.ts` |
| `performed_at` | ISO string | formatted per `lib/workouts.ts` |

**Rule**: the status label, the badge styling, the date format, and the
column layout have exactly one definition each in `lib/workouts.ts` /
`components/workout-table.tsx`. A list may choose which columns to show; it
may not restate how a column looks (FR-024).

### Page position

The `/workouts` page's paging state. Replaces the earlier
`(string | undefined)[]` cursor stack, and the composite `(before, before_id)`
cursor that briefly replaced it (research #2).

| Field | Type | Notes |
| --- | --- | --- |
| `page` | integer ≥ 1 | the entire paging state |

One integer. "Newer" and "Older" set it from the `prev_page` / `next_page` the
last response carried, so the client never computes a page number itself and
never has to know how many rows exist.

The response envelope (`Paginated<T>` in `apps/web/lib/pagination.ts`) mirrors
the API's: `data`, `total`, `page`, `per_page`, `next_page`, `prev_page`. Two
consequences worth naming:

- **The over-fetch is gone.** The list used to request `PAGE_SIZE + 1` rows and
  infer "there is more" from getting a full extra one. `next_page !== null`
  says it outright.
- **`total` is displayed**, so the header can show a real count — and the
  optimistic delete adjusts it with the row so the count never contradicts the
  list while a request is in flight.

## 3. Client-side signal: logged workout

Not persisted, not fetched — an in-memory publication from the logging form
to whatever is on screen (research #1). Lives in
`apps/web/services/workout-events.ts`.

| Field | Type | Meaning |
| --- | --- | --- |
| `revision` | integer | increments on every successful log; lists keep it in their effect dependencies and refetch when it changes (FR-011) |
| `lastPerformedAt` | ISO string \| null | the performed date of the workout just logged; the dashboard compares its week against the week on screen and moves if they differ (FR-012) |

**Access**: read through `useSyncExternalStore` — the same primitive and the
same reasoning as the existing token store in `use-require-auth.ts`.

**Lifetime**: the browser tab. It is not persisted and does not need to be:
its only job is to invalidate views that are currently mounted. A page
reload refetches everything anyway.

**Explicit non-responsibility**: this signal carries *newly logged*
workouts only. It does not carry the later `pending → parsed` transition
produced by the worker — that is FR-013, deferred to its own spec. Nothing
in this store should be designed to make that case work; it is the seam that
gets replaced when it does.

## 4. Unchanged

For the avoidance of doubt, this feature does not alter: the `users`,
`workout_exercises`, `sets` tables; the Mongo `raw_uploads` collection or
GridFS storage; the RabbitMQ event contract between `apps/api` and
`apps/worker`; token issuance, rotation, or storage; the weekly-volume
aggregation and its `isoWeekKey` definition.
