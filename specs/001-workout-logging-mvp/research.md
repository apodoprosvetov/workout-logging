# Phase 0 Research: Workout Logging MVP

All items below were either explicit `NEEDS CLARIFICATION` markers in
the initial Technical Context draft, or open questions carried over
from [design-notes.md](./design-notes.md). Each is resolved here so
Phase 1 design can proceed without unknowns.

## 1. Backend language/framework

- **Decision**: TypeScript on Node.js 22 LTS; NestJS on top of the
  Fastify HTTP adapter (`@nestjs/platform-fastify`) for the API
  service. Data access via TypeORM (Postgres entities) and Mongoose
  (MongoDB schemas); request validation via `class-validator` +
  `class-transformer` DTOs.
- **Rationale**: User-selected — explicit goal to use NestJS for this
  project's business logic and models, and to learn the framework.
  Keeping the Fastify adapter preserves the original throughput
  rationale (2s ingestion ack budget, FR-009/SC-002) while gaining
  Nest's module/controller/service/DI structure and idiomatic
  ORM/ODM-backed "model" layer (TypeORM + Mongoose).
- **Revision note (was Fastify-only)**: The initial decision picked
  bare Fastify + `zod`, rejecting NestJS as "more structure than a
  small MVP needs." Revisited after the user chose to use this feature
  as a chance to learn NestJS — the structure/learning-curve tradeoff
  is intentional now, not a cost to avoid. `apps/worker` (no HTTP
  surface, just RabbitMQ consumers) is unaffected and stays a plain
  Node process using the shared raw Postgres/MongoDB/Redis clients in
  `packages/shared`.
- **Constraint this creates**: NestJS's constructor-based DI (and
  TypeORM's/Mongoose's decorator-based entity/schema definitions)
  depend on `emitDecoratorMetadata`, which only `tsc` (not esbuild-
  based tools like `tsx`) emits correctly. `apps/api` therefore
  compiles as CommonJS via `@nestjs/cli`/`tsc`, diverging from the
  repo-root `tsconfig.json`'s NodeNext/ESM setup.
  **Correction (made during T006)**: this constraint is about the
  compiler (`tsc` vs. esbuild), not the module format, but
  `packages/shared` still can't simply stay on the root NodeNext/ESM
  config — `apps/api`'s CommonJS code `require()`s it, and a CJS
  `require()` cannot reliably load a pure-ESM package. So
  `packages/shared` also compiles to CommonJS (same override as
  `apps/api`: `module: commonjs`, `moduleResolution: node`, plus
  `experimentalDecorators`/`emitDecoratorMetadata` for its entities/
  schemas). This direction is one-way-safe: `apps/worker` stays ESM
  (NodeNext) and freely `import`s the CJS `packages/shared` output —
  Node's ESM-importing-CJS interop is unproblematic — it's only
  CJS-importing-ESM that doesn't work synchronously.
- **Same constraint hits Vitest too (found in T008)**: Vitest's default
  transform is esbuild, same limitation. `apps/api/vitest.config.ts`
  uses the `unplugin-swc` plugin (swc emits decorator metadata
  correctly, tsconfig-aware) so tests exercising Nest's `TestingModule`
  DI actually resolve constructor-injected providers — verified with a
  throwaway DI smoke test. `apps/worker`'s tests don't need this: it
  never declares its own decorated classes, only imports already-built
  entities/schemas from `packages/shared`'s CommonJS `dist/` output.
  standalone libraries — they don't require NestJS. So the canonical
  entity/schema definitions live once in `packages/shared`
  (`src/entities/*.entity.ts` for Postgres, `src/schemas/*.schema.ts`
  for MongoDB), and both processes consume the same classes:
  `apps/api` registers them through `@nestjs/typeorm`'s/
  `@nestjs/mongoose`'s `forFeature()`; `apps/worker` (no HTTP surface,
  no Nest) opens its own standalone `DataSource`/`mongoose.connect()`
  importing the identical shared classes. This replaces the earlier
  "raw `pg`/`mongodb` client in `packages/shared`, used only by
  `apps/worker`" framing — `apps/worker` now uses TypeORM/Mongoose too,
  for one model layer shared project-wide instead of two. Redis stays
  a raw `ioredis` client shared as-is (no ORM concept applies to rate-
  limit counters / cached aggregates).
- **Alternatives considered**: Express (more boilerplate for
  validation); bare Fastify + zod (original decision, see above —
  rejected on revision because it doesn't serve the learning goal).

## 2. Web frontend

- **Decision**: Next.js (App Router), calling `apps/api` over HTTP —
  not using Next.js API routes for business logic, since the worker
  needs a long-running Node process anyway (Next.js serverless routes
  aren't a good fit for RabbitMQ consumers).
- **Rationale**: User-selected. Keeps all data access and user-scoping
  in one service (`apps/api`), so FR-015 (no cross-user data leakage)
  has a single enforcement point instead of being duplicated in
  Next.js route handlers too.
- **Alternatives considered**: Next.js full-stack (API routes talk to
  DB directly) — rejected because the worker still needs a standalone
  process, so splitting API from web doesn't add real cost but does
  avoid duplicating auth/scoping logic in two places.

## 3. RabbitMQ topology (explicitly deferred in design-notes.md)

- **Decision**:
  - One topic exchange: `workout.events`.
  - `workout.uploaded` → routing key `workout.uploaded` → queue
    `workout.parse.q`, consumed by the parser worker.
  - `workout.parsed` → routing key `workout.parsed` → queue
    `workout.analytics.q`, consumed by the analytics worker.
  - Retry with backoff: each primary queue's messages that fail
    processing are nacked to a per-queue retry queue with a message TTL
    (5s → 30s → 5m, 3 attempts total) whose dead-letter-exchange
    routes back to the primary queue after the TTL expires.
  - After 3 failed attempts, the message is routed to
    `workout.dlq` (final dead-letter queue) and the associated workout
    is marked `failed` in Postgres (distinct from `needs_review`, which
    is a successful-but-low-confidence parse — see data-model.md).
- **Rationale**: Topic exchange (not direct/fanout) leaves room for
  future consumers (e.g. a notifications service) to bind additional
  queues without changing the publisher. The retry-queue-with-TTL
  pattern is the standard RabbitMQ way to get delayed retry without
  the delayed-message plugin.
- **Alternatives considered**: RabbitMQ delayed-message-exchange plugin
  (adds an operational dependency not present by default); infinite
  immediate retry (would violate "backoff" in design-notes.md's
  non-functional section and could hot-loop against a struggling Claude
  API).
- **Attempt-count bug + fix (2026-09-03)**: the retry-tier decision
  originally read RabbitMQ's `x-death` header (the count of TTL
  dead-letter hops). That only works for the *first* hop — `retry.ts`
  re-publishes the failed message to the next tier with `sendToQueue`,
  and RabbitMQ strips the reserved `x-death` on any client publish, so
  on the next dead-letter the count resets to 1 and the message loops
  in `workout.parse.q.retry.30s` forever: never reaching the 5m tier,
  never the DLQ, the workout stuck `pending`, one "parse failed" log
  line every 30s. Found in local dev with ~73 stale test events
  grinding for over a day. Fixed by carrying an explicit
  `x-retry-attempt` integer header that the worker sets itself and
  RabbitMQ preserves across the dead-letter hop (`getRetryAttempt` /
  `handleParseFailure` in `apps/worker/src/parser/retry.ts`). The
  exchange is internal (only `apps/api` publishes `workout.uploaded`),
  so "a client could forge the counter" isn't a real concern. Also:
  a failure that retrying can never fix — a missing `raw_uploads` doc
  or `workouts` row — now throws `NonRetryableParseError`, which
  `handler.ts` turns into an immediate `failed` + ack instead of
  4 pointless retry attempts. Regression tests: `parser.spec.ts`
  "walks the tiers via the default parameter" and "the x-retry-attempt
  header survives a real TTL dead-letter hop".

## 4. Idempotent event processing (FR-014)

- **Decision**: Each event carries a UUID `event_id` (already in the
  draft payload). The worker keeps a small `processed_events(event_id
  PK, processed_at)` table in Postgres and wraps handling in: insert
  `event_id` (fails on conflict → skip, already processed) → do the
  work → commit. Combined with a guarded status transition
  (`UPDATE workouts SET status = 'parsed' WHERE id = $1 AND status =
  'pending'`) so even a race between two redelivered copies can't
  double-write.
- **Rationale**: A dedicated dedup table is simpler to reason about
  than relying solely on RabbitMQ's own delivery semantics (at-least-
  once, not exactly-once), and the guarded `UPDATE` is a cheap second
  line of defense.
- **Alternatives considered**: Relying only on the status-guarded
  `UPDATE` (rejected — doesn't protect the MongoDB writes / Claude API
  call from happening twice, only the final Postgres write).

## 5. Telegram bot delivery mode

- **Decision**: Webhook (not long-polling), hosted as a route inside
  `apps/api` (`POST /telegram/webhook`).
- **Rationale**: Avoids a fourth always-on process; `apps/api` is
  already always-on to serve the web app. At personal scale, one more
  route has negligible cost.
- **Alternatives considered**: Long-polling in a dedicated process
  (simpler local dev with no public URL needed, but adds an extra
  deployable process for no real benefit once `apps/api` is deployed
  anyway).

## 6. Auth token design

- **Decision**: JWT access token, 15-minute expiry; refresh token,
  opaque random string, stored hashed (argon2) in Postgres with a 30-day
  expiry, rotated (old one invalidated) on every refresh.
- **Rationale**: Standard short-access/long-refresh pattern; hashing
  the stored refresh token means a DB leak doesn't hand out valid
  tokens directly. Password hashing also via argon2 (FR-001).
- **Refresh-token lookup (refined during T020)**: argon2 salts randomly
  per call, so `argon2.hash(token)` never matches a previously-stored
  hash for the same input — a plain `WHERE token_hash = ?` lookup is
  impossible, unlike password verification (which already knows *which*
  row to check via the email lookup first). Resolved with a
  selector/validator split: the raw token handed to the client is
  `{refreshTokens.id}.{secret}` — the existing PK doubles as the
  selector (indexed, no schema change), the server looks up the row by
  `id`, then `argon2.verify(token_hash, secret)`. Standard pattern for
  this exact problem (e.g. Laravel Sanctum).
- **Alternatives considered**: Long-lived single JWT with no refresh
  (rejected — no way to revoke short of waiting out expiry, weaker than
  refresh rotation for negligible simplicity gain). SHA-256 instead of
  argon2 for the refresh token (would allow a direct hash lookup without
  the selector split, and is arguably more appropriate given a refresh
  token is already high-entropy, not a guessable password — rejected
  only to keep the originally-decided argon2 choice rather than revise
  it, per user preference).

## 7. Exercise → muscle group matching (FR-011)

- **Decision**: Claude is prompted to return its best-guess canonical
  exercise name per recognized movement; the worker looks that name up
  against `exercise_catalog.aliases` in MongoDB (case-insensitive exact
  match on alias list). No match → the exercise is still recorded
  (workout is not blocked), but the workout as a whole is flagged
  `needs_review` since muscle-group attribution is incomplete.
- **Rationale**: Keeps matching deterministic and debuggable (a fixed
  alias list) rather than asking the AI to also pick the muscle group,
  which would make muscle-group data harder to correct in bulk later.
- **Alternatives considered**: Let Claude assign muscle groups directly
  (rejected — no single source of truth, harder to fix a bad mapping
  for one exercise across all historical workouts).
- **Matching upgrade (2026-09-03)**: exact alias match was too brittle
  in practice — a real workout ("Upper Body A", `b661fe2e`) had 4 of 6
  exercises miss because of word order ("Dumbbell Bench press incline"
  vs the catalog's "Incline Dumbbell Press") and plurals ("Pull-ups" vs
  "pull-up"). Match key is now `exercise_catalog.normalized_aliases`: the
  name and every alias run through `normalizeExerciseName`
  (`packages/shared/src/exercise-match.ts`) — lowercase, split on
  non-alphanumerics, singularize each token, de-duplicate, sort. So
  aliases only need one phrasing per equipment variant, not every word
  order. Abbreviation synonyms (`db`/`dumbbell`, `bb`/`barbell`) are
  still separate aliases. The `aliases: 1` Mongo index is replaced by
  `normalized_aliases: 1`.
- **Muscle-group vocabulary**: `chest, triceps, shoulders, back, biceps,
  forearms, quads, glutes, hamstrings, calves, core`. `forearms` and
  `calves` were added with the 2026-09-03 catalog expansion (~20 → 72
  entries). Wrist/reverse curls are `forearms` (not `biceps` — a common
  mis-tag that would inflate biceps volume). Adding a group = add it here
  and to a catalog entry, nothing else (the analytics worker attributes
  volume to whatever list an entry carries).
- **Catalog is shared reference data**: seed moved from
  `apps/api/src/db/` to `packages/shared/src/db/seed-exercise-catalog.ts`
  (`npm run seed:exercises --workspace=@workout-logging/shared`),
  since both `apps/api` (seeding) and `apps/worker` (matching, and the
  parser integration test) need it. Upserts by slug; the 20 pre-expansion
  entries keep their original slug so already-parsed workouts don't
  orphan. Re-running is safe and recomputes `normalized_aliases`.
- **Known**: re-seeding does **not** fix already-parsed workouts — their
  `workout_exercises` point at the old slugified fallback rows
  (`dumbbell-rows`, `dips`, ...). Re-submit the workout or write a
  slug-remap migration.

## 8. Unified ingestion endpoint (revises design-notes.md R7/R8/R10)

- **Decision**: One ingestion endpoint (`POST /workouts`) and one
  `workout.uploaded` event/`raw_uploads` document, which can carry
  free text, an image, or both from a single submission — instead of
  design-notes.md's implied text-vs-image split (R7 vs. R8), which the
  original design carried into two separate API routes
  (`/workouts/text`, `/workouts/upload`) and two separate parser code
  paths.
- **Rationale**: A real submission can legitimately contain both at
  once — a Telegram photo message with a caption is text *and* an
  image in one message. Two mutually-exclusive ingestion paths either
  silently drop one of them (the caption, if only the photo path is
  taken) or force the client into two separate calls that would each
  create their own workout row for what is conceptually one workout.
  Nothing in spec.md's FR-007/FR-008/FR-010 actually requires two
  entry points — that split was an implementation detail introduced in
  the original design draft, not a product requirement.
- **Consequences**:
  - `raw_uploads` (data-model.md): the `type: "text" | "image"` +
    `content_or_ref` fields are replaced by two independent optional
    fields, `text` and `image_ref` — at least one must be present.
  - `workouts` (data-model.md): the `input_type: "text" | "image"`
    enum is replaced by two booleans, `has_text` / `has_image`.
  - `workout.uploaded` (events.md): the `type` field is dropped. The
    worker fetches the `raw_uploads` doc directly and branches on
    which of `text` / `image_ref` is populated, sending Claude a
    single combined request (text block + image block) when both are
    present, per research.md #7's exercise-matching flow.
- **Alternatives considered**: keep two endpoints but let each accept
  an optional companion field (e.g. `/workouts/text` also takes an
  optional image) — rejected, still two entry points for one concept,
  more surface area to keep in sync, and ambiguous which one a
  "both text and image" submission should hit.

## 9. LLM provider (revises the "Claude" assumption throughout, found during T031)

- **Decision**: The `ANTHROPIC_API_KEY` provisioned for this project is
  a DeepSeek key, not an Anthropic one (confirmed: a real call to
  Anthropic's actual API 401s on it; the same key succeeds against
  DeepSeek's Anthropic-compatible endpoint). `apps/worker/src/parser/claude.ts`
  keeps using `@anthropic-ai/sdk` unmodified, but constructs the client
  with `baseURL: 'https://api.deepseek.com/anthropic'` and
  `model: 'deepseek-v4-pro'` — a deliberate user choice, not a
  workaround to revisit later.
- **Consequence — extended thinking changes the tool-use contract**:
  this model runs extended thinking by default, which does not support
  a *forced* tool choice (`tool_choice: {type: 'tool', name: ...}`
  400s with "Thinking mode does not support this tool_choice").
  `extractWorkoutFromText` uses `tool_choice: {type: 'auto'}` instead,
  which means "the model didn't call `record_workout`" is a real,
  expected outcome (ambiguous/garbage input) — mapped to zero
  exercises extracted, not treated as an error. Response parsing must
  also skip past `thinking` content blocks to find the `tool_use` one.
- **Verified for real** (T031): the exact quickstart.md Story-1 input
  ("Push day: bench press 80kg x8, x8, x6; overhead press 40kg x10,
  x10, x8") round-trips through a real API call to the correct
  structured `{exercises: [...]}` shape.
- **Reliability finding (found during the research.md #10 work,
  reproduced 3× in a small manual sample)**: DeepSeek sometimes returns
  `stop_reason: 'tool_use'` with an **empty `input: {}`** — the
  `thinking` block shows the correct extraction was reasoned through,
  but the arguments never got serialized into the call. This is
  distinct from the documented "model declines to call the tool at
  all" outcome (genuinely ambiguous input, `!toolUse`, mapped to zero
  exercises / `needs_review`) — an empty-input tool call is a
  call-level glitch, not an ambiguous-input signal. `extractWorkoutFromText`
  now throws when `toolUse` exists but `input.exercises` isn't an
  array (a required schema field), so this goes through the T032
  retry/DLQ path instead of being silently recorded as a permanent
  zero-exercise result. Verified live: this exact glitch fired during
  a real test run and self-healed on the 5s retry tier.

## 10. Extracting `name` and `performed_at` from raw content (post-T032 refinement)

- **Problem**: real-world workout logs often embed a day-label name and
  a date directly in the text (e.g. "Низ А - 09.08.2026"), which the
  original T029/T030 design ignored entirely — `name` stayed always
  null, and `performed_at` silently defaulted to ingestion time unless
  the client passed an explicit ISO8601 value.
- **`name`**: spec.md's Assumptions defer AI-*inferred* naming (guessing
  a label like "Push day" from the exercise list) beyond MVP — that
  scope boundary still holds. What's implemented here is *extraction*
  of a label the user already wrote, not inference: `record_workout`'s
  tool schema gained an optional `name` field with an explicit
  instruction to omit it rather than invent one. `apps/worker/src/parser/handler.ts`
  writes it to `workouts.name` only when non-empty; otherwise the row
  stays unnamed exactly as before.
- **`performed_at`**: no existing FR/Assumption governed this — an
  unexamined gap, not a deliberate MVP boundary. Fixed with a priority
  order: explicit client-supplied `performed_at` (at `POST /workouts`)
  wins > a date extracted from the raw text/image > ingestion time as
  the last-resort default. A new `workouts.performed_at_explicit`
  boolean (migration `AddPerformedAtExplicitToWorkouts`) records which
  case applied at ingestion, so the parser worker knows whether it's
  allowed to overwrite `performed_at` with an extracted date.
  `record_workout`'s tool schema gained an optional `performed_at`
  field (`YYYY-MM-DD`), validated with a strict regex + `Date` parse
  before use (`isValidIsoDate` in `claude.ts`) rather than trusted
  as-is.
- **Verified for real** (parser.spec.ts): the user's own example
  ("Низ А - 09.08.2026") round-trips through a real DeepSeek call to
  `name: "Низ А"`, `performed_at: 2026-08-09`; a workout seeded with an
  explicit `performed_at` keeps it unchanged even when the text
  contains a different date; text with no embedded label leaves `name`
  null.

## 11. Multiple images per submission + transient GridFS storage (revises research.md #8, T042, spec.md FR-020)

- **Problem**: a real workout often can't fit in one photo (a
  multi-page paper log; a Telegram album — a single Telegram post can
  carry several photos in one message group). The original single-`image`
  design (research.md #8) silently lost every image past the first.
- **Multi-image decision**: `POST /workouts`'s `image` field becomes
  `images` (repeatable multipart field, `Buffer[]`), capped at
  `MAX_WORKOUT_IMAGES = 10` (`packages/shared/src/schemas/raw-upload.schema.ts`).
  `raw_uploads.image_ref: string | null` becomes `image_refs: string[]`.
  `@fastify/multipart` (keyValues mode) hands a *single* file back as a
  bare `Buffer`, not a 1-element array — `CreateWorkoutDto` normalizes
  this with a `class-transformer` `@Transform` so nothing downstream has
  to special-case it (verified: sending 1 vs. 3 vs. 11 `images` parts all
  behave correctly, 11 rejected with 400 by `@ArrayMaxSize`).
- **Storage decision — transient, not indefinite (revises FR-020 for images
  specifically)**: rather than deciding on a durable object-storage backend
  (new infra — S3/MinIO — vs. inlining bytes in the `raw_uploads` doc,
  which risks Mongo's 16MB/doc limit with up to 10 unrestricted-size
  images per spec.md Clarifications Q4), images are now processed and
  discarded — only the derived structured data (`workout_exercises`/`sets`)
  and `ai_response_raw` (kept for debugging) are retained indefinitely.
  Considered and rejected:
  - Redis with a TTL — simplest, self-expiring, but RAM-priced; a burst
    of concurrent large-image submissions at scale (e.g. 1000 users)
    could spike memory cost/risk significantly, and would share an
    instance with the tiny rate-limit counters (T019).
  - A raw TTL index directly on GridFS's `fs.files` collection — looked
    like "free" self-cleanup, but MongoDB's TTL monitor only deletes the
    matched `.files` doc, not its `.chunks` — orphaned chunks accumulate
    forever. Not used, to avoid a silent leak.
  - **Chosen**: GridFS (`packages/shared/src/db/gridfs.ts`, bucket
    `workout_images`) for storage — disk-backed (no RAM-cost scaling
    concern), no document-size ceiling, no new infrastructure (same
    Mongo already in docker-compose) — combined with **explicit
    deletion on terminal status**, not a TTL index: the parser worker
    deletes a workout's `image_refs` via `deleteWorkoutImages()` right
    after it reaches `parsed`/`needs_review` (`handler.ts`), or once
    exhausted to `workout.dlq`/`failed` (`retry.ts`'s `handleParseFailure`).
    Both call sites are best-effort (try/catch + log) — a cleanup
    failure must not fail or re-retry an already-resolved workout.
- **Why this doesn't affect T032's retry guarantee**: images are only
  deleted once a workout is *terminal* — retries (5s/30s/5m tiers) all
  happen before that point, so every retry attempt still has the full
  image set available, identical to today. No changes to `retry.ts`'s
  retry-tier routing logic itself were needed.
- **Known limitation**: manual DLQ recovery (retry.ts's existing
  "best-effort... DLQ message is still the source of truth" comment)
  can no longer recover the original image bytes once cleanup has run
  — a user would need to resubmit the photo(s). Accepted for MVP; no
  sweep/backstop job for a cleanup call that itself fails mid-flight
  (narrow race, would leave orphaned GridFS files) — not built, judged
  disproportionate to the risk at MVP scale.
- **Verified for real**: `POST /workouts` with 3 real multipart image
  attachments creates 3 real GridFS files (queried directly, not just
  inferred from a 202); 11 images gets a 400; a seeded workout with 2
  GridFS-backed images has both files deleted once parsing reaches a
  terminal status; a seeded workout routed straight to DLQ (4th
  failure) also has its images deleted; a GridFS bucket census after
  the full apps/api + apps/worker test suites confirms zero orphaned
  files/chunks left behind.

## 12. Missing indexes on T033/T034's read paths (found via EXPLAIN)

- **Finding**: ran `EXPLAIN`/`EXPLAIN ANALYZE` on the exact SQL TypeORM
  generates for `GET /workouts` and `GET /workouts/:id`. Neither
  `workout_exercises.workout_id`, `sets.workout_exercise_id`, nor
  `workouts.user_id`/`performed_at` had an index beyond each table's
  primary key — TypeORM does not index `@ManyToOne` FK columns
  automatically. Invisible at near-empty table size (Postgres correctly
  prefers a seq scan there), but every join/filter/sort on these read
  paths would degrade to a full table scan at real data volume.
- **Decision**: added three indexes via `@Index()` on the entities +
  migration `AddIndexesForWorkoutReadPaths`: `workout_exercises(workout_id)`,
  `sets(workout_exercise_id)` (both single-column, for the detail
  query's joins), and a composite `workouts(user_id, performed_at)`
  (matches the list query's `WHERE user_id = ... ORDER BY performed_at DESC`
  access pattern exactly — Postgres can scan a btree backwards, so one
  ascending composite index serves the DESC sort without a separate
  sort step).
- **Verified for real**: seeded a synthetic 500-workout /
  1000-workout_exercises / 3000-sets dataset (cleaned up after), reran
  both queries — the detail query now shows `Bitmap Index Scan`/`Index Scan`
  on the two new FK indexes instead of seq-scanning; the list query
  shows `Index Scan Backward` on the composite index, no separate
  `Sort` node in the plan at all.
- **Follow-up (T047, 2026-09-03)**: reviewing `computeWeeklyVolume`'s
  query. Added `workout_exercises(exercise_id)` — the last un-indexed FK
  on these tables (migration `AddExerciseIdIndexToWorkoutExercises`);
  not needed by the weekly-volume query itself (its `we → e` join goes
  via `exercises` PK) but spec-003's per-exercise history
  (`WHERE we.exercise_id = X`) will need it, and an un-indexed FK also
  forces a full scan on any `exercises` delete. **Not added**: a
  `workouts(user_id, status, performed_at)` composite — `EXPLAIN` shows
  the weekly query drives from `workouts` on the existing
  `(user_id, performed_at)` index (one user, one week ≈ a handful of
  rows) and filters `status` on those; `status` isn't selective enough
  to earn a wider index. **Rejected**: replacing the JS-computed
  `[monday, next_monday)` bounds with `date_trunc('week', performed_at)`
  in SQL — that predicate isn't sargable against the `(user_id,
  performed_at)` btree (would need a functional index), and
  `date_trunc('week', timestamptz)` truncates in the session `TimeZone`
  GUC rather than UTC, so it could silently disagree with
  `isoWeekKey`'s UTC week label. The range-bounds form keeps the index
  scan and the timezone explicit.

## 13. CORS (found during T035 — apps/web calling apps/api from a real browser)

- **Finding**: `apps/api` had no CORS configuration at all. Every
  contract test up to this point talks to `apps/api` via `supertest`
  (a raw HTTP client, no CORS enforcement) — CORS is a *browser*
  mechanism, so nothing in the test suite could have caught this. Only
  actually loading `apps/web` (port 3001) in a browser context and
  having it call `apps/api` (port 3000) would surface it: preflight
  `OPTIONS` 404s, and the browser blocks the real request even though
  a plain `curl` (no CORS enforcement either) shows nothing wrong.
- **Decision**: `app.enableCors({ origin: webOrigin })` in
  `apps/api/src/main.ts`, `webOrigin` from a new `WEB_ORIGIN` env var
  (defaults to `http://localhost:3001`, matching apps/web's `dev -p 3001`).
  No `credentials: true` — apps/web stores tokens in `localStorage` and
  sends them via `Authorization: Bearer`, not cookies, so no
  cookie-credentialed CORS mode is needed. Required adding
  `@fastify/cors` (Nest's Fastify adapter dynamically imports it for
  `enableCors()`; not previously a dependency).
- **Verified for real**: a real preflight `OPTIONS` and a real `POST`
  to `/auth/register`, both sent with `Origin: http://localhost:3001`
  against a live `apps/api`, carry `access-control-allow-origin` in
  the response — confirmed missing before the fix, present after.

## 14. Vision model for the image branch (found during T044)

- **Finding**: the LLM provider chosen in research.md #9 —
  `deepseek-v4-pro` via DeepSeek's Anthropic-compatible endpoint — is
  **text-only**. T044's image/vision branch (`extractWorkout` with
  `images`) sent well-formed Anthropic `image` content blocks and got
  back, in the model's own thinking, *"the image is unsupported"*. The
  endpoint accepts and forwards the block; the model just can't see it.
  Verified with two live one-off calls (a 1×1 test PNG): `deepseek-v4-pro`
  → "unsupported"; `deepseek-v4-flash-vision-exp` → correctly named the
  colour.
- **Decision**: `apps/worker/src/parser/claude.ts` picks the model per
  request — `deepseek-v4-flash-vision-exp` (the only DeepSeek model with
  vision) whenever the submission carries any images, `deepseek-v4-pro`
  (unchanged, better at text reasoning) for text-only. A combined
  text+image submission (research.md #8) goes to the vision model as one
  call with the text folded into the same message.
- **Confirmed compatible** (live): `deepseek-v4-flash-vision-exp` supports
  the same `client.messages.stream()` + `.finalMessage()`, `tools` +
  `tool_choice: {type: 'auto'}`, and `thinking`/`tool_use` response shape
  as `deepseek-v4-pro`, so the existing `record_workout` parsing in
  `claude.ts` is unchanged — only the model id and `max_tokens` differ.
  Image blocks: base64 only (no `anthropic-beta` header needed — that's
  only for the Files API `file_id` source), `user` messages only,
  jpeg/png/gif/webp, 32 MiB / 600 images per request (far above
  `MAX_WORKOUT_IMAGES = 10`), ~384 tokens billed per image.
- **`media_type` is sniffed, not trusted**: uploads carry no validated
  format (spec.md Clarifications Q4) and a GridFS filename isn't reliable,
  so `apps/worker/src/parser/image-media-type.ts` detects the type from
  magic bytes. An unrecognised image throws → the parse fails into the
  T032 retry/DLQ path rather than silently dropping that image.
- **`downloadWorkoutImage`** (`packages/shared/src/db/gridfs.ts`) does
  **not** soft-swallow a missing file the way `deleteWorkoutImages` does:
  it only runs while a workout is still being parsed, and research.md #11
  guarantees images survive until a terminal status (across every retry),
  so a ref that doesn't resolve is a real fault and rejects.
- **Known risks**: `deepseek-v4-flash-vision-exp` is experimental
  (`-exp`) — DeepSeek may change or withdraw it; a real fallback would be
  a separate vision provider. Flash-tier text reasoning is below
  `v4-pro`, which is why text-only stays on `v4-pro`. `ai_response_raw`
  is now populated (the full serialized model response, for debugging)
  on every parse, per research.md #11.
- **Client-side validation is UX-only** (T046): `apps/web`'s upload
  control rejects a wrong MIME type, >10MB, or >10 files before submit,
  but this is **not** mirrored on the API — spec.md Clarifications Q4
  keeps the endpoint accepting any file, and this branch's magic-byte
  sniff + retry/DLQ path is the real "downstream error handling". An
  empty `file.type` is let through client-side for the same reason (the
  worker sniffs the bytes).
- **Not covered here**: routing Telegram photo messages into ingestion
  (T045). The `apps/web` multi-file upload control (T046) is done — one
  unified text-and-images form (`log-workout-form.tsx`), submit enabled
  on text or ≥1 image.
