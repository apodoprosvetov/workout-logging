# API Contract Delta: Web Shell & Weekly Dashboard

**Feature**: 003-web-shell-weekly-dashboard | **Date**: 2026-09-08

A delta against the authoritative contract,
[`specs/001-workout-logging-mvp/contracts/api.md`](../../001-workout-logging-mvp/contracts/api.md).
Only `GET /workouts` changes. On implementation, these changes are folded
into that file — it stays the single source of truth; this document records
what moved and why.

## `GET /workouts`

Auth required. Scoped to the caller (FR-015 of spec 001). Sorted and
paginated by `performed_at` descending — not `created_at`, so a backlogged
entry sorts by when it happened.

### Query parameters

| Parameter | Type | Status | Meaning |
| --- | --- | --- | --- |
| `status` | enum | unchanged | filter by processing status |
| `limit` | integer 1–100 | unchanged | page size; defaults to 20 when absent |
| `before` | ISO 8601 | **semantics extended** | upper bound on `performed_at`, exclusive |
| `after` | ISO 8601 | **already added** (working tree) | lower bound on `performed_at`, inclusive |
| `before_id` | UUID | **new in this feature** | tie-break companion to `before` |

### `after` — half-open windows

`after` (inclusive) with `before` (exclusive) bound `performed_at` as a
half-open `[after, before)` window. Passing both fetches exactly one week:
`after` = the week's Monday 00:00 UTC, `before` = the next Monday 00:00 UTC.

This parameter already exists in the working tree with contract tests
covering the lower bound, the combined week window, and a 400 on a malformed
value. It is listed here because it is part of this feature's story, not
because it is outstanding work.

### `before_id` — pagination that cannot skip rows

**Problem it solves.** With `before` alone the cursor is a strict `<` on
`performed_at`. Workouts sharing a `performed_at` that straddle a page
boundary are dropped silently. Not a corner case: the logging form uses a
date input, so `performed_at` is midnight, and two workouts on one day
collide exactly (FR-022, research #2).

**Behaviour.** When `before_id` is supplied, the filter is a row-value
comparison over the pair, and the sort carries the same tie-break:

```
WHERE (performed_at, id) < (:before, :before_id)
ORDER BY performed_at DESC, id DESC
```

**Rules.**

- `before_id` is optional.
- `before_id` MUST be accompanied by `before`. Supplying `before_id` alone
  is a client error → **400**.
- `before` without `before_id` keeps its existing meaning exactly — a plain
  exclusive bound on `performed_at`. Existing callers are unaffected.
- A malformed `before_id` (not a UUID) → **400**.
- `before_id` need not identify an existing workout; it is a sort position,
  not a lookup. An unknown UUID returns whatever sorts after that position.

**Ordering change.** The response order becomes `performed_at DESC, id DESC`
for every caller, not only those passing `before_id`. Previously ties were
returned in unspecified order. This is a tightening, not a break: any order
that was valid before is still a valid subset, and the cursor now has a
stable position to resume from.

**Client usage.** To page forward, send the last visible row's
`performed_at` as `before` and its `id` as `before_id`.

### Response

Unchanged: `{ workouts: [{ id, name, source, status, performed_at, created_at }] }`

No total and no has-more flag — callers that need to know whether another
page exists over-fetch by one row, as `/workouts` does today.

### Contract tests

In `apps/api/tests/contract/workouts.list.spec.ts`, matching the file's
existing style:

1. Given several workouts sharing one `performed_at` and a page boundary
   falling among them, paging with `(before, before_id)` returns every
   workout exactly once across pages — none skipped, none repeated.
2. `before_id` without `before` → 400.
3. A malformed `before_id` → 400.
4. `before` alone still behaves as a plain exclusive bound (regression guard
   for existing callers).

## Not changing

`GET /workouts/:id`, `POST /workouts`, `DELETE /workouts/:id`, the auth
endpoints, and `GET /analytics/weekly-volume` are untouched by this feature.
In particular, weekly volume keeps taking a `week` key (`YYYY-Www`) rather
than a date range — the dashboard sends it the ISO key for the same week it
sends `after`/`before` for, and `packages/shared`'s `isoWeekKey` remains the
one definition of what a week is (research #9).
