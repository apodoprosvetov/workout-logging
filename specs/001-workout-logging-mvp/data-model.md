# Data Model: Workout Logging MVP

Derived from [design-notes.md](./design-notes.md)'s original schema,
adjusted for decisions made in [spec.md](./spec.md) (Clarifications) and
[research.md](./research.md).

## PostgreSQL (normalized, transactional)

### `users`

| Field | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `email` | text, unique | |
| `password_hash` | text | argon2 (research.md #6) |
| `telegram_chat_id` | bigint, nullable, unique | column exists; the linking flow that would set it is **descoped** (spec.md US2, 2026-09-04) — always null |
| `created_at` | timestamptz | |
| `deleted_at` | timestamptz, nullable | soft-delete marker; see Account Deletion below |

### `refresh_tokens`

| Field | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `user_id` | uuid, FK → users.id | |
| `token_hash` | text | argon2 hash of the opaque token |
| `expires_at` | timestamptz | issued_at + 30 days |
| `revoked_at` | timestamptz, nullable | set on rotation/logout |

### `telegram_link_codes` — REMOVED (2026-09-04)

Created by InitialSchema, never written to (the Telegram linking flow was
never built), **dropped** by migration `DropTelegramLinkCodes1788506977000`.
The `TelegramLinkCode` entity and the linking-code rate-limit helpers
(`LINK_CODE_RATE_LIMIT` / `linkCodeRateLimitKey` / `checkLinkCodeRateLimit`,
old FR-005) were deleted with it. `users.telegram_chat_id` is a separate
column and is still present (unused) — a follow-up migration can drop it.

### `workouts`

| Field | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `user_id` | uuid, FK → users.id | every query scoped by this (FR-015) |
| `name` | text, nullable | e.g. "Push day"; extracted by the parser worker only if literally present in the raw text/image (research.md #10) — never invented from the exercise list, so AI-*inferred* naming stays deferred beyond MVP per spec.md Assumptions |
| `source` | enum: `web` \| `telegram` | always `web` — `telegram` unused (US2 descoped) |
| `has_text` | boolean | mirrors `raw_uploads.text` presence (research.md #8) |
| `has_image` | boolean | mirrors `raw_uploads.image_ref` presence (research.md #8) |
| `raw_input_ref` | text | points to `raw_uploads._id` in MongoDB |
| `status` | enum: `pending` \| `parsed` \| `needs_review` \| `failed` | see State Transitions |
| `performed_at` | timestamptz | when the workout happened; caller-supplied value at ingestion wins if given, else overwritten by a date extracted from the raw text/image, else defaults to ingestion time (research.md #10) |
| `performed_at_explicit` | boolean | true iff the caller passed `performed_at` on `POST /workouts` — tells the parser worker whether it's allowed to overwrite `performed_at` with an extracted date (research.md #10) |
| `created_at` | timestamptz | when ingested |

### `workout_exercises`

| Field | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `workout_id` | uuid, FK → workouts.id | |
| `exercise_id` | uuid, FK → exercises.id | |
| `exercise_order` | int | order performed |

### `sets`

| Field | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `workout_exercise_id` | uuid, FK → workout_exercises.id | |
| `set_order` | int | |
| `weight` | numeric | 0 for bodyweight-only sets with no external weight mentioned (research.md #10) |
| `reps` | int | |
| `unit` | enum: `kg` \| `lb`, default `kg` | (spec.md Assumptions) |

### `exercises`

| Field | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `slug` | text, unique | join key with MongoDB `exercise_catalog` |
| `name` | text | canonical display name |

### `processed_events`

| Field | Type | Notes |
|---|---|---|
| `event_id` | uuid, PK | dedup guard, research.md #4 |
| `processed_at` | timestamptz | |

**Relationships**: one `workout` → many `workout_exercises` (ordered) →
many `sets` (ordered) each. One `user` → many `workouts`,
`refresh_tokens`.

**Validation rules**:
- `sets.reps` > 0, `sets.weight` >= 0.
- `workouts.has_text` OR `workouts.has_image` MUST be true — a
  submission needs at least one of text/image (research.md #8);
  enforced at the ingestion endpoint, not just at write time.
- `workouts.user_id` MUST match the authenticated caller on every read
  and write (FR-015) — enforced in `apps/api`'s data-access layer, not
  optional per-query.

**State transitions** (`workouts.status`):

```
pending --(parse succeeds, exercises fully matched)--> parsed
pending --(parse succeeds, low confidence / unmatched exercise)--> needs_review
pending --(parse fails after 3 retries)--> failed
```

`needs_review` and `failed` are both terminal in the MVP — no
edit/resubmit flow (spec.md Clarifications, Q1). A user may delete a
workout in any status.

## MongoDB (documents, less structured)

### `raw_uploads`

```
{
  _id,
  user_id,
  text,                  // raw text, nullable
  image_refs,            // GridFS file id array (workout_images bucket), max MAX_WORKOUT_IMAGES (10), transient — see below
  ai_response_raw,       // full Claude response, retained for debugging
  created_at
}
```

At least one of `text` / `image_refs` MUST be present (research.md #8,
#11); both may be present at once (e.g. a photo with a text note), and up to `MAX_WORKOUT_IMAGES` (10) images may be present
(research.md #11 — e.g. a multi-page paper log).

`text` and `ai_response_raw` are retained indefinitely by default
(FR-020); deleted on account deletion (FR-021, see below). The actual
image bytes referenced by `image_refs` are **transient**: stored in
GridFS (`packages/shared/src/db/gridfs.ts`) only until the associated
workout reaches a terminal status, then deleted by the parser worker
(research.md #11) — `image_refs` may point to already-deleted files
past that point.

### `exercise_catalog`

```
{
  slug,
  name,
  aliases: [string],
  normalized_aliases: [string],   // name + aliases, token-sorted & singularized
  muscle_groups: [string],        // from the vocab below
  equipment                       // barbell | dumbbell | cable | machine | bodyweight | null
}
```

The parser matches on `normalized_aliases` (research.md #7,
`packages/shared/src/exercise-match.ts`), so word order and plurals
don't matter. `muscle_groups` vocabulary: `chest, triceps, shoulders,
back, biceps, forearms, quads, glutes, hamstrings, calves, core`.

Seeded/maintained independently of user data
(`packages/shared/src/db/seed-exercise-catalog.ts`, upsert by slug); not
deleted on account deletion.

## Redis (ephemeral / derived)

- `ratelimit:ingest:{user_id}` — sliding-window counter, 30/minute
  (FR-018).
- `weekly_volume:{user_id}:{iso_week}` — hash of `muscle_group →
  volume` (`iso_week` = `YYYY-Www`), where volume = `Σ weight × reps`
  over that week's `parsed`/`needs_review` workouts, full set volume
  credited to every muscle group the exercise lists. The analytics
  worker **fully recomputes and overwrites** the hash on every
  `workout.parsed` for that week (T047, `computeWeeklyVolume` in
  `packages/shared/src/analytics.ts`) — idempotent, self-corrects on
  delete/re-parse. 120-day TTL. Read by the dashboard (FR-017) with the
  same `computeWeeklyVolume` as a Postgres fallback on cache miss.

## Account Deletion (FR-021)

Implemented as `DELETE /auth/account` (T050 — `AuthService.deleteAccount`).
Deleting an account MUST remove: the `users` row (hard delete after
cascading — soft-delete via `deleted_at` is only an intermediate step
if a grace period is wanted later, not required for MVP), all
`workouts`/`workout_exercises`/`sets` for that user (explicit ORM cascade
in one transaction — the FKs are `ON DELETE NO ACTION`), all
`refresh_tokens`, all MongoDB `raw_uploads` for that user plus the GridFS
image bytes they reference, and all Redis keys scoped to that `user_id`
(`ratelimit:ingest:{id}`, every `weekly_volume:{id}:*`). `exercise_catalog`
and shared `exercises` rows are never user-owned and are unaffected.
