# Quickstart: Validating the Workout Logging MVP

Proves User Story 1 (text logging) end-to-end, then layers on Stories
2–4. Uses [contracts/api.md](./contracts/api.md) — see there for full
request/response shapes.

## Prerequisites

- Docker Compose running Postgres, MongoDB, Redis, RabbitMQ (see
  `docker-compose.yml`, plan.md Project Structure).
- `apps/api` and `apps/worker` running against that stack.
- `apps/web` running, pointed at `apps/api`.
- Environment variables set (never committed, FR-019): DB connection
  strings, `JWT_SECRET`, `ANTHROPIC_API_KEY` (`TELEGRAM_BOT_TOKEN` is
  descoped — see Story 2).
- Postgres migrated (data-model.md schema applied) and MongoDB
  `exercise_catalog` seeded with at least a few common exercises
  (e.g. "bench press", "overhead press") and their muscle groups.

## Story 1 — Text logging (P1)

```bash
# Register
curl -sX POST localhost:3000/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"correct horse battery staple"}'
# → access_token, refresh_token

# Log a workout as text
curl -sX POST localhost:3000/workouts \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -F 'text=Push day: bench press 80kg x8, x8, x6; overhead press 40kg x10, x10, x8'
# → 202 { workout_id, status: "pending" }   (must return in < 2s — SC-002)
```

**Expected**: within a few seconds, `GET /workouts/:id` shows
`status: "parsed"` with two exercises (bench press, overhead press),
each with its own sets matching the input exactly (SC-003). If it
instead shows `needs_review`, check `apps/worker` logs and the
`ai_response_raw` field in MongoDB `raw_uploads` for why.

## Story 2 — Telegram (P2) — DESCOPED (2026-09-04)

Not built. Telegram is deferred to a future spec (a conversational MCP
server). See spec.md User Story 2.

## Story 3 — Photo logging (P3)

Upload a screenshot of a workout via the web app (`POST /workouts` with
one or more `images` fields). **Expected**: same `pending → parsed`
flow as Story 1, sourced from image content instead of text. Also try a
photo *with a text note in the same submission* — **Expected**: both
the note and the image are used in the same parse (research.md #8), not
just one or the other.

## Story 4 — Weekly dashboard (P4)

After a few parsed workouts across different muscle groups:

```bash
curl -s localhost:3000/analytics/weekly-volume -H "authorization: Bearer $ACCESS_TOKEN"
# → { week, volumes: [{ muscle_group, volume }, ...] }
```

**Expected**: matches what the web dashboard chart shows; values update
within a few seconds of a new workout parsing (SC-007).

## Cross-cutting checks

- **Duplicate delivery (SC-006)**: manually redeliver a
  `workout.uploaded` message in the RabbitMQ management UI for an
  already-processed workout. **Expected**: no duplicate workout is
  created; `processed_events` already has that `event_id`.
- **User isolation (SC-005)**: register a second account, confirm its
  `GET /workouts` is empty despite the first account's data existing,
  and that `GET /workouts/:id` for the first account's workout returns
  404 (not 403) when called with the second account's token.
- **Account deletion (FR-021)**: call `DELETE /auth/account`, then
  confirm the user's rows are gone from Postgres, their `raw_uploads`
  are gone from MongoDB, and their Redis keys are gone.
