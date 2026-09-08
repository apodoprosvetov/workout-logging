# API Contract: Workout Logging MVP

All endpoints served by `apps/api`. All except `/auth/*` require
`Authorization: Bearer <access_token>`; the
authenticated `user_id` comes from the token only — never from a path
or body parameter (FR-015).

Every request body / query param is validated by a class-validator DTO
through the global `ValidationPipe` (`whitelist` + `forbidNonWhitelisted`
+ `transform`, T023/T051): an unknown field, a wrong type, or a
constraint violation is a `400` before the handler runs.

## Auth

### `POST /auth/register`
- Body: `{ email: string (≤254, trimmed + lowercased), password: string (8–200) }`
- 201: `{ access_token, refresh_token, user: { id, email } }`
- 400: invalid email, password outside 8–200 chars, unknown field
- 409: email already registered

### `POST /auth/login`
- Body: `{ email: string (normalised as above), password: string (≤200) }`
- 200: `{ access_token, refresh_token }`
- 401: invalid credentials

### `POST /auth/refresh`
- Body: `{ refresh_token: string (non-empty, ≤512) }`
- 200: `{ access_token, refresh_token }` (old refresh token revoked, new one issued)
- 401: refresh token invalid/expired/revoked

### `DELETE /auth/account`
- Auth required.
- 204: account and all associated data deleted (FR-021; see
  data-model.md Account Deletion)

## Telegram linking — DESCOPED (spec.md US2, 2026-09-04)

`POST /telegram/link-code` and `POST /telegram/webhook` were never
built. Telegram is deferred to a future spec (a conversational MCP
server). The `telegram_link_codes` table was dropped 2026-09-04
(migration `DropTelegramLinkCodes`); the unused `users.telegram_chat_id`
column remains for now.

## Ingestion

### `POST /workouts`
- Auth required. Rate-limited: 30/minute/user (FR-018).
- Multipart body: `text?: string` (≤50 000 chars — 400 past that),
  `images?: file[]` (repeat the field for each image; max
  `MAX_WORKOUT_IMAGES` = 10 — 400 past that), `performed_at?: ISO8601`.
  At least one of `text` / `images` MUST be present — 400 if neither
  (research.md #8, #11). Both may be present at once (e.g. a photo with a text note in one
  submission), and multiple images may be present at once (e.g. a
  multi-page paper log).
- No format/size validation per image in MVP (spec.md Clarifications, Q4).
  Image bytes are transient — deleted once parsing reaches a terminal
  status (research.md #11); only the derived structured data is retained.
- `performed_at` is optional. When omitted the server dates the workout at the
  moment of the request. This is contractual, not incidental — a client that
  needs the date must be able to rely on it rather than re-implement it.
- 202: `{ workout_id: uuid, status: "pending", performed_at: ISO8601 }` —
  returned in < 2s (FR-009/SC-002); parsing happens asynchronously.
  `performed_at` is echoed back so the caller knows the date the workout
  landed on even when it supplied none.
- Caveat on `performed_at`: when the caller did **not** supply it, the parser
  may later move the workout to a date it finds in the text. The response
  states where the workout landed at creation; following it afterwards needs
  live updates (spec 003 FR-013), which the MVP does not have.

## Reading data

### Pagination (all list endpoints)

Every list endpoint takes the same two query params and answers in the same
envelope. Superseded spec 003: `limit` no longer exists and is rejected.

- Query: `?page=` (integer ≥ 1, default 1) and `?per_page=` (integer 1–100,
  default 20). Out-of-range or non-integer values → 400. A page past the end
  returns an empty `data` array with `next_page: null`, not an error.
- 200: `{ data: [...], total, page, per_page, next_page, prev_page }`
  - `total` — rows matching the filters, across all pages.
  - `next_page` / `prev_page` — page numbers, or `null` at the ends. Derivable
    from the other three; present so a client can page by null-check rather
    than by arithmetic.

Any list endpoint's ordering MUST end in a unique column. Offset pagination
over a non-total ordering silently skips and repeats rows between pages,
because the database may order tied rows differently for each page's query.

### `GET /workouts`
- Auth required. Scoped to caller (FR-015).
- Sorted by `performed_at` desc, then `id` desc — not `created_at`, since a
  backlogged entry sorts by when it happened, not when it was uploaded. The
  `id` tie-break is required, not cosmetic: the web form supplies a date, so
  every workout logged for one day shares `performed_at` exactly.
- Query: `?status=&before=&after=` plus the pagination params above.
  `before` (ISO8601, exclusive) and `after` (ISO8601, inclusive) are filters,
  not pagination: they bound `performed_at` as a half-open `[after, before)`
  window — pass both to fetch a single week (`after` = week start, `before` =
  next week start).
- 200: the standard envelope, with
  `data: [{ id, name, source, status, performed_at, created_at }]`

### `GET /workouts/:id`
- Auth required. 404 (not 403) if the workout belongs to another user
  or doesn't exist — never confirm existence of another user's data.
- 200: `{ id, name, status, source, performed_at, exercises: [{ name, order, sets: [{ order, weight, reps, unit }] }] }`

### `GET /analytics/weekly-volume`
- Auth required. Scoped to caller.
- Query: `?week=YYYY-Www` (ISO week, week 01–53; default current) — 400 on a
  malformed or out-of-range value
- 200: `{ week: string, volumes: [{ muscle_group: string, volume: number }] }`
- Reads Redis cache first, falls back to a Postgres computation on
  cache miss (FR-016), per data-model.md.
