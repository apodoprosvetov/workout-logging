# Design Notes: Workout Logging MVP (ingestion + AI parsing + auth + Telegram bot)

Status: Draft v0.2
Date: 2026-08-20

> This is the original hand-written technical draft that preceded
> `spec.md` in this directory. `spec.md` is the business-facing
> spec-kit specification (WHAT/WHY, no tech stack) generated from it.
> This file retains the architecture/technology decisions, data model,
> event schema, and API surface already worked out here — `/speckit-plan`
> should treat it as authoritative input alongside `spec.md`.

## Why

Manually logging workouts in notes or spreadsheets is tedious and gives no
analytics. The goal is to log a workout quickly — as text or a screenshot,
from a phone or directly from Telegram at the gym — and let AI parse it
into structured data, so progress per muscle group is visible over time.

## Actors

- **User** — an account in the web application (email + password).
- **Telegram-linked user** — the same account, linked to a Telegram
  `chat_id` for fast logging without opening the web app.

## Design decisions

- **MVP is single-user in practice, multi-user by design.** Only one
  person will use this system for now, but every table carries a
  `user_id`, and every API endpoint is scoped by the authenticated
  user's id. There is no shortcut (no hardcoded user, no global tables)
  — adding a second real user later should require zero schema changes.
- **Message broker: RabbitMQ.** Simpler local setup than Kafka, and
  sufficient throughput for a personal-scale system. Revisit only if
  event volume or multi-consumer fan-out patterns outgrow it.
- **Event payload schema is not finalized.** A draft is proposed below;
  confirm before running `/plan`.

## Scope — MVP v0.1

### In scope
- Registration / login (email + password, JWT access + refresh token)
- Linking a Telegram account via a one-time code
- Logging a workout as text (web and Telegram)
- Logging a workout as a screenshot/photo (web and Telegram)
- AI parsing (Claude) into structured exercises and sets
- Exercise → muscle group mapping
- Storage: Postgres (normalized data), MongoDB (raw uploads, exercise
  catalog with rich metadata)
- Async pipeline via RabbitMQ (upload → parse → normalize)
- Redis cache for weekly aggregates
- Basic dashboard: workout history, weekly volume per muscle group chart

### Out of scope (future specs)
- Weekly AI review and recommendations
- Program planning vs actual adherence tracking
- Voice input
- Multi-language exercise names
- Mobile app

## Requirements (EARS)

### Auth

- **R1 (MUST):** WHEN a user registers with email and password, THE
  system SHALL create an account and issue a JWT access token plus a
  refresh token.
- **R2 (MUST):** WHEN a user requests to link Telegram, THE system SHALL
  generate a one-time linking code valid for 10 minutes.
- **R3 (MUST):** WHEN the Telegram bot receives `/start <code>`, THE
  system SHALL validate the code, bind the `chat_id` to the user's
  account, then invalidate the code.
- **R4 (MUST):** WHEN an unlinked Telegram chat sends a message, THE bot
  SHALL reply with instructions to link the account via the web app.
- **R5 (SHOULD):** Linking codes SHALL be single-use and rate-limited to
  5 attempts per hour per account.
- **R6 (MUST):** Every API endpoint that reads or writes workout data
  SHALL scope its query by the authenticated user's id. No endpoint
  SHALL return or accept data for a `user_id` other than the caller's.

### Ingestion

- **R7 (MUST):** WHEN a user sends a text description of a workout (web
  or Telegram), THE system SHALL store the raw text, associate it with
  `user_id`, and publish a `workout.uploaded` event.
- **R8 (MUST):** WHEN a user sends a photo/screenshot (web or Telegram),
  THE system SHALL store the image reference and upload metadata in
  MongoDB, associate it with `user_id`, and publish a `workout.uploaded`
  event.
- **R9 (MUST):** The ingestion API SHALL respond to the client in under
  2 seconds regardless of AI parsing time (processing is asynchronous).

### AI Parsing

- **R10 (MUST):** WHEN a `workout.uploaded` event is consumed, THE
  parser worker SHALL call the Claude API to extract exercises, sets,
  reps, and weight from the raw input.
- **R11 (MUST):** THE parser SHALL map each recognized exercise name to
  muscle group(s) using the exercise catalog in MongoDB, matching against
  known aliases.
- **R12 (MUST):** WHEN parsing succeeds, THE system SHALL write
  normalized records to Postgres (workout, workout_exercises, sets) and
  publish a `workout.parsed` event.
- **R13 (MUST):** WHEN parsing fails or the AI's confidence is low, THE
  system SHALL mark the workout `needs_review` instead of silently
  discarding it.
- **R14 (MUST):** Event consumption SHALL be idempotent — reprocessing
  the same `event_id` SHALL NOT create a duplicate workout record.

### Analytics

- **R15 (MUST):** WHEN a `workout.parsed` event is published, THE
  analytics worker SHALL update the cached weekly volume per muscle
  group in Redis for that `user_id`.
- **R16 (MUST):** The dashboard API SHALL read aggregates from Redis
  first, falling back to a Postgres computation on cache miss.

## Data model

### Postgres

```
users
  id (uuid, pk)
  email
  password_hash
  telegram_chat_id (nullable, unique)
  created_at

workouts
  id (uuid, pk)
  user_id (fk -> users.id)
  name (nullable text, e.g. "Push day", "Leg day")
  source (enum: web | telegram)
  raw_input_ref (points to MongoDB raw_uploads._id)
  status (enum: pending | parsed | needs_review | failed)
  performed_at (timestamp — when the workout happened)
  created_at (timestamp — when the record was ingested)

workout_exercises
  id (uuid, pk)
  workout_id (fk -> workouts.id)
  exercise_id (fk -> exercises.id)
  exercise_order (int)

sets
  id (uuid, pk)
  workout_exercise_id (fk -> workout_exercises.id)
  set_order (int)
  weight (numeric)
  reps (int)
  unit (enum: kg | lb, default kg)

exercises
  id (uuid, pk)
  slug (unique text — join key with MongoDB catalog)
  name (text — canonical display name)
```

Relationship: one workout has many workout_exercises (one row per
exercise performed, in order); each workout_exercise has many sets (one
row per set, in order). This models "5 exercises, each with its own
number of sets, each set with its own weight and reps" directly.

### MongoDB

```
raw_uploads
  { _id, user_id, type: text|image, content_or_ref,
    ai_response_raw, created_at }

exercise_catalog
  { slug, name, aliases: [], muscle_groups: [], equipment }
```

The `exercises` table in Postgres stores only what relational joins need
(id, slug, canonical name) for referential integrity and fast queries.
The richer, frequently-edited metadata (aliases, muscle groups,
equipment) lives in MongoDB, keyed by the same `slug`. The parser
resolves a recognized name against MongoDB aliases, then upserts a
matching row into the Postgres `exercises` table if one doesn't exist
yet.

## Proposed event payload (draft — confirm before /plan)

```json
// workout.uploaded
{
  "event_id": "uuid",
  "user_id": "uuid",
  "workout_id": "uuid",
  "type": "text | image",
  "raw_upload_ref": "mongo _id",
  "occurred_at": "ISO 8601"
}

// workout.parsed
{
  "event_id": "uuid",
  "user_id": "uuid",
  "workout_id": "uuid",
  "exercise_count": 5,
  "occurred_at": "ISO 8601"
}
```

## API surface (draft)

```
POST /auth/register
POST /auth/login
POST /auth/refresh

POST /telegram/link-code          # generates a linking code

POST /workouts/text               # quick text logging (web)
POST /workouts/upload             # screenshot logging (web)
GET  /workouts                    # history, scoped to caller's user_id
GET  /workouts/:id                # detail view with exercises + sets
GET  /analytics/weekly-volume     # per-muscle-group aggregates
```

All endpoints except `/auth/*` require a valid JWT; the authenticated
`user_id` is taken from the token, never from a request parameter.

## Telegram bot commands

```
/start <code>   — link account
<text>          — log a workout as text
<photo>         — log a workout as a screenshot
```

## Acceptance scenarios

**Scenario: logging a full workout as text via Telegram**
Given a registered user with a linked Telegram account,
When they send "Push day: bench press 80kg x8, x8, x6; overhead press
40kg x10, x10, x8" to the bot,
Then a workout named "Push day" appears in the web dashboard with two
exercises (bench press, overhead press), each with its own sets and
correct weight/reps per set.

**Scenario: unlinked chat**
Given a Telegram chat with no linked account,
When it sends any message,
Then the bot replies with instructions to link the account via the web
app.

**Scenario: duplicate event from the broker**
Given a `workout.uploaded` event has already been processed
successfully,
When RabbitMQ redelivers the same event (at-least-once delivery),
Then the system does not create a duplicate workout record.

**Scenario: user isolation**
Given two accounts exist in the system,
When user A calls `GET /workouts`,
Then only user A's workouts are returned, regardless of how many
workouts exist for other users.

## Non-functional

- Secrets (Telegram bot token, Claude API key) are provided via
  environment variables only, never committed to the repository.
- Ingestion endpoints are rate-limited per user (via Redis) to prevent
  abuse.
- RabbitMQ: failed parsing attempts retry with backoff, then route to a
  dead-letter queue after N attempts.
- Raw AI responses are retained in MongoDB for debugging and future
  prompt refinement.

## Open questions

- Exact RabbitMQ exchange/queue topology (direct vs topic exchange,
  queue names, retry/DLQ configuration) — to be defined during `/plan`.
- Whether `workouts.name` should be inferred by the AI parser when the
  user doesn't provide one explicitly (e.g. inferred from muscle groups
  present) — nice-to-have, not blocking MVP.
