# API Contract: Workout Logging MVP

All endpoints served by `apps/api`. All except `/auth/*` and
`/telegram/webhook` require `Authorization: Bearer <access_token>`; the
authenticated `user_id` comes from the token only — never from a path
or body parameter (FR-015).

## Auth

### `POST /auth/register`
- Body: `{ email: string, password: string }`
- 201: `{ access_token, refresh_token, user: { id, email } }`
- 409: email already registered

### `POST /auth/login`
- Body: `{ email: string, password: string }`
- 200: `{ access_token, refresh_token }`
- 401: invalid credentials

### `POST /auth/refresh`
- Body: `{ refresh_token: string }`
- 200: `{ access_token, refresh_token }` (old refresh token revoked, new one issued)
- 401: refresh token invalid/expired/revoked

### `DELETE /auth/account`
- Auth required.
- 204: account and all associated data deleted (FR-021; see
  data-model.md Account Deletion)

## Telegram linking

### `POST /telegram/link-code`
- Auth required.
- Rate-limited: 5/hour/account (FR-005).
- 201: `{ code: string, expires_at: ISO8601 }` (10-minute validity, FR-003)

### `POST /telegram/webhook`
- No user auth (Telegram-signed webhook; validated via bot token secret
  in the URL path or a secret header, not a JWT).
- Handles `/start <code>` (link), unlinked-chat messages (reply with
  instructions, FR-006), and workout submissions (text/photo) from
  already-linked chats — routed internally to the same ingestion logic
  as the web endpoints below.
- 200 always (Telegram expects a fast 200; errors are logged, not
  surfaced to Telegram as HTTP failures).

## Ingestion

### `POST /workouts`
- Auth required. Rate-limited: 30/minute/user (FR-018).
- Multipart body: `text?: string`, `images?: file[]` (repeat the field for
  each image; max `MAX_WORKOUT_IMAGES` = 10 — 400 past that), `performed_at?: ISO8601`.
  At least one of `text` / `images` MUST be present — 400 if neither
  (research.md #8, #11). Both may be present at once (e.g. a Telegram photo
  message with a caption forwarded as one submission), and multiple images
  may be present at once (e.g. a multi-page paper log or a Telegram album).
- No format/size validation per image in MVP (spec.md Clarifications, Q4).
  Image bytes are transient — deleted once parsing reaches a terminal
  status (research.md #11); only the derived structured data is retained.
- 202: `{ workout_id: uuid, status: "pending" }` — returned in < 2s
  (FR-009/SC-002); parsing happens asynchronously.

## Reading data

### `GET /workouts`
- Auth required. Scoped to caller (FR-015).
- Query: `?status=&limit=&before=` (sorted/paginated by `performed_at` desc,
  not `created_at` — a backlogged entry sorts by when it happened, not
  when it was uploaded)
- 200: `{ workouts: [{ id, name, source, status, performed_at, created_at }] }`

### `GET /workouts/:id`
- Auth required. 404 (not 403) if the workout belongs to another user
  or doesn't exist — never confirm existence of another user's data.
- 200: `{ id, name, status, source, performed_at, exercises: [{ name, order, sets: [{ order, weight, reps, unit }] }] }`

### `GET /analytics/weekly-volume`
- Auth required. Scoped to caller.
- Query: `?week=` (ISO week, default current)
- 200: `{ week: string, volumes: [{ muscle_group: string, volume: number }] }`
- Reads Redis cache first, falls back to a Postgres computation on
  cache miss (FR-016), per data-model.md.
