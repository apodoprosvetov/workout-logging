# API Contract Delta: Web Shell & Weekly Dashboard

**Feature**: 003-web-shell-weekly-dashboard | **Date**: 2026-09-08
**Revised**: 2026-09-08 — keyset `before_id` replaced by shared offset
pagination (research #2, #11)

A delta against the authoritative contract,
[`specs/001-workout-logging-mvp/contracts/api.md`](../../001-workout-logging-mvp/contracts/api.md).
These changes are folded into that file on implementation — it stays the single
source of truth; this document records what moved and why.

## New: pagination, shared by every list endpoint

**Breaking.** `limit` is retired. A caller still sending it gets **400** —
`main.ts`'s `ValidationPipe` runs with `forbidNonWhitelisted`, so a retired
parameter is reported rather than ignored.

### Request

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `page` | integer ≥ 1 | 1 | below 1 or non-integer → 400 |
| `per_page` | integer 1–100 | 20 | outside the range → 400 |

Capped at 100 so no single request can ask the database for an unbounded scan.
100 is also exactly what the dashboard's whole-week query needs, so the cap
constrains no real caller.

### Response

```json
{
  "data": [ ... ],
  "total": 137,
  "page": 2,
  "per_page": 20,
  "next_page": 3,
  "prev_page": 1
}
```

- `total` — rows matching the filters across all pages, from the same
  `getManyAndCount()` that fetches the page.
- `next_page` / `prev_page` — page numbers, `null` at the ends. Derivable from
  the other three; present so a client pages by null-check instead of by
  arithmetic it has to get right.
- snake_case throughout, matching the bodies the API already returns
  (`performed_at`, `access_token`, `workout_id`).

A page past the end returns `data: []` with `next_page: null` — an empty page,
not a 404.

### Ordering requirement

**Any list endpoint's `ORDER BY` must end in a unique column.** Offset
pagination over a non-total ordering silently skips and repeats rows between
pages, because the database is free to order tied rows differently for each
page's query. This is a contract-level rule, not an implementation note.

## `GET /workouts`

Auth required. Scoped to the caller (spec 001 FR-015).

### Ordering — changed

`performed_at DESC, id DESC`. Previously `performed_at DESC` alone, with ties
in unspecified order.

The `id` tie-break is load-bearing, not tidiness. Reproduced against
Postgres 16 on the real schema: three workouts sharing one `performed_at` come
back `A,B,C` under a sequential scan and `C,B,A` under an index scan. And ties
are ordinary here — the logging form uses a date input, so `performed_at` is
midnight and every workout logged for one day collides exactly.

This is what the retired `before_id` design was for; the total order solves it
for offset pagination too, and for any scheme adopted later.

Supported by index `("user_id", "performed_at", "id")` — ascending, since the
ordering is uniformly descending and a btree reads backwards.

### Query parameters

| Parameter | Status | Meaning |
| --- | --- | --- |
| `status` | unchanged | filter by processing status |
| `before` | unchanged | upper bound on `performed_at`, exclusive |
| `after` | unchanged | lower bound on `performed_at`, inclusive |
| `page`, `per_page` | **new** | pagination, as above |
| `limit` | **removed** | → 400 |

`before` and `after` remain **filters, not pagination**: together they bound
`performed_at` as a half-open `[after, before)` window. Passing both fetches
exactly one week — `after` = the week's Monday 00:00 UTC, `before` = the next
Monday 00:00 UTC. The dashboard pairs them with `per_page=100` to take a week
whole.

### Response

The standard envelope, with
`data: [{ id, name, source, status, performed_at, created_at }]`.

Previously `{ workouts: [...] }`. Callers no longer over-fetch one extra row to
guess whether another page exists — that is `next_page !== null`.

### Contract tests

In `apps/api/tests/contract/workouts.list.spec.ts`:

1. Tied `performed_at` rows come back in `id DESC` order, and the same order on
   a repeated request — guards the total ordering directly.
2. Paging with `per_page=2` over 7 workouts, 5 of which share one
   `performed_at`, visits every row exactly once — the scenario that made two
   rows unreachable under the old cursor.
3. The envelope's defaults are `page: 1`, `per_page: 20`, with `prev_page: null`.
4. A page past the end returns `data: []` and `next_page: null`, status 200.
5. `per_page=101` → 400; `page=0` → 400; `limit=5` → 400.

## Not changing

`GET /workouts/:id`, `POST /workouts`, `DELETE /workouts/:id`, the auth
endpoints, and `GET /analytics/weekly-volume` are untouched. Weekly volume in
particular is an aggregate for one week (`{ week, volumes }`), not a list, so
the envelope does not apply to it — `GET /workouts` is currently the only list
endpoint in the API.
