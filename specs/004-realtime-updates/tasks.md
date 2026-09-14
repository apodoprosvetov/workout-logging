---
description: "Task list for 004-realtime-updates"
---

# Tasks: Real-Time Updates

**Input**: Design documents from `/specs/004-realtime-updates/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: **Required, not optional.** Constitution v1.0.0 Principle II mandates a
contract test for every new `apps/api` route, and this feature's Principle II
decision (plan.md) adds `vitest` to `apps/web` for pure client logic.

**Organization**: Grouped by user story so each is independently implementable
and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on incomplete work)
- **[Story]**: US1–US4, mapping to spec.md user stories
- Exact file paths included

## Path Conventions

Monorepo with npm workspaces: `packages/shared/`, `apps/api/`, `apps/worker/`,
`apps/web/`. Paths below are repository-relative, per plan.md's structure.

---

## Phase 1: Setup

**Purpose**: Close the Principle II gate and de-risk the one unverified
technical assumption before anything depends on it.

- [X] T001 Add `vitest` to devDependencies and a `"test": "vitest run --passWithNoTests"` script in `apps/web/package.json` so the root `npm test` (`--workspaces --if-present`) picks it up. The flag matches `apps/worker`'s existing script and keeps the root run green until T016 lands the first test
- [X] T002 [P] Create `apps/web/vitest.config.mts` mirroring `apps/worker/vitest.config.ts` (`environment: 'node'`, `globals: true`, include `**/*.spec.ts`); no jsdom or React Testing Library — this covers pure logic only. `.mts` rather than `.ts`, and `vite-tsconfig-paths` added: see the config's own comments for both reasons
- [X] T003 Spike `@Sse()` under the Fastify adapter in `apps/api`: verify frames flush immediately and client disconnect is observable. Record the outcome in `specs/004-realtime-updates/research.md` #11. If it misbehaves, the fallback is writing to `reply.raw` in the controller — decide here, before T010. **Outcome: `@Sse()` passes on all three counts** (first frame 7 ms, exact 500 ms intervals, teardown fires on disconnect); `reply.raw` not needed. Three findings folded into T010 and `contracts/api.md` — see research.md #12

**Checkpoint**: `npm test --workspace=apps/web` runs (vacuously), and the SSE
mechanism is a known quantity.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The update channel itself — types, fan-out, endpoint, client
reader. No notification content flows yet; each user story adds its own.

**⚠️ CRITICAL**: No user story can begin until this phase is complete.

### Shared contracts

- [X] T004 Define the `ChangeNotification` discriminated union (`workout.settled`, `workout.created`, `workout.deleted`, `analytics.updated`) and the per-user channel-name helper in `packages/shared/src/events/notifications.ts`, matching [contracts/events.md](./contracts/events.md) §1 exactly — snake_case wire fields
- [X] T005 Export the new module from `packages/shared/src/index.ts`
- [X] T006 [P] Add a subscriber-mode Redis client factory — a separate connection, since ioredis forbids other commands on a subscribed client. **Landed in `packages/shared/src/events/redis-pubsub.ts`, not `db/redis.ts` as originally written**: here Redis is a transport, not a datastore, so it belongs beside `events/rabbitmq.ts` where this repo already keeps its message-transport connection factory. `redisUrl` is imported from `db/redis.ts` rather than re-resolved, keeping one definition of `REDIS_URL`. Kept out of `notifications.ts` so the notification types stay free of a runtime dependency (they are needed in `apps/web` at T015/T019). Exported from the barrel

### API: fan-out and endpoint

- [X] T007 [P] Implement `NotificationsPublisher` (publish one `ChangeNotification` to the user's Redis channel, best-effort: log and swallow failures, never propagate) in `apps/api/src/events/notifications.publisher.ts`. Injects the existing `REDIS_CLIENT` (publishing is an ordinary command — the subscriber connection from T006 is T009's business). Wired into `events.module.ts` with `RedisModule` in `imports`
- [X] T008 [P] Implement the per-replica connection registry (userId → open streams, add/remove driven by the connection's own close event, per-user cap) in `apps/api/src/events/connection-registry.ts`. Cap is 10 per replica; `register` refuses with `null` (T010 decides whether that becomes a throw). Both return the 0→1 / 1→0 transitions — `isFirstForUser` and a `wasLast` boolean — so T009 can subscribe and unsubscribe from the user's Redis channel on one lookup rather than two. Registered in `events.module.ts` ahead of T011 so it actually instantiates
- [X] T009 Implement `NotificationsSubscriber` — subscribe per connected user, route incoming notifications to that user's local connections only — in `apps/api/src/events/notifications.subscriber.ts`. One Redis connection for the whole process carrying every channel (not one per user). Exposes `openStream`/`closeStream` so the subscribe/unsubscribe pair stays tied to the registry's 0→1 and 1→0 transitions in one place; `null` from `openStream` means the cap (→ `429`), a throw means the backend is unavailable (→ `503`). Fan-out added to `ConnectionRegistry.broadcast()` so the stream set never leaves the registry
- [X] T010 Implement `GET /api/events` in `apps/api/src/events/events.controller.ts` using Nest's `@Sse()` (proven viable in T003): `JwtAuthGuard`, one frame per notification, and a 15-second `event: heartbeat` frame (research #9 — CloudFront's unset `origin_read_timeout` defaults to 30s). Do **not** add `@Header()` for cache/buffering headers — `@Sse()` sets them itself and manual ones duplicate on the wire (research #12). Drop the connection from the registry in the Observable's teardown callback, which T003 confirmed fires on client disconnect. The stream MUST also **close when its access token expires** rather than outliving the session (FR-006, second clause) — the client reopens with a refreshed token, which is why reconnection is routine here rather than an error path
- [X] T011 Wire publisher, subscriber, registry and controller into `apps/api/src/events/events.module.ts` and register it in `apps/api/src/app.module.ts`. `EventsModule` must also import `AuthModule` — `@UseGuards(JwtAuthGuard)` needs `AuthTokensService` resolvable in this module's own DI subtree, the same reason already commented in `workouts.module.ts:21-23`. Doing so surfaced a latent defect: `notifications.publisher.ts` imported `REDIS_CLIENT` via `'src/redis/redis.module'` while everything else used a relative path, and under vitest the two specifiers load the file twice — giving two distinct `Symbol('REDIS_CLIENT')` values, so the provider no longer satisfied the injection. All internal imports in `apps/api/src` are now relative

### API: contract tests

- [X] T012 [P] Contract test in `apps/api/tests/contract/events.auth.spec.ts`: no token → 401; expired token → 401; valid token → 200 with `text/event-stream` and the documented cache/buffering headers
- [X] T013 [P] Contract test in `apps/api/tests/contract/events.delivery.spec.ts`: a notification published for user A reaches A's stream, and **nothing** reaches user B's stream (FR-005, SC-011) — assert on the raw stream, not on rendered state
- [X] T014 [P] Contract test in `apps/api/tests/contract/events.limits.spec.ts`: opening past the per-user cap returns 429, and closing a stream frees a slot. All three share `tests/helpers/sse.ts` — supertest buffers until a response ends, which an SSE response never does, so these hold a real socket open instead. That is also the only way to assert what a *second* connection does **not** receive

### Web: the channel client

- [X] T015 [P] Implement the SSE frame parser as an exported pure function (bytes/string chunks → parsed events, handling frames split across chunks, several frames per chunk, and `:` comment lines) in `apps/web/services/event-stream.ts`. Returns `SseFrame` (`{ event, data }` as text), **not** `ChangeNotification`: a heartbeat is a frame but not a notification, and `JSON.parse` throws — a pure function has no good answer to that, while the reader in T018 does. Purity is kept by threading the carry-over explicitly (`rest` in, `buffer` out) rather than holding a buffer in a closure. LF only; the docblock records why CRLF is out and how it would fail
- [X] T016 [P] Unit-test the parser in `apps/web/services/event-stream.spec.ts`: event split across two chunks; two events in one chunk; heartbeat ignored; malformed frame discarded without killing the stream. **Written before T015** so the interface was decided by what callers need. 22 tests. Note the task text above predates T003: the heartbeat is a named event, not a `:` comment — both are covered. One case replays a verbatim `curl -N` capture from the running API, including the bare leading `\n` that `@Sse()` opens with, which a naive split turns into a phantom frame
- [X] T017 [P] Implement backoff as an exported pure function (attempt → delay, growth with a cap) in `apps/web/services/event-stream.ts` and unit-test growth and capping in `apps/web/services/event-stream.spec.ts`. Sequence `0, 250, 500, 1000, 2000, 4000, 5000…` — attempt 0 is immediate on purpose: the commonest reconnect here is not a failure but the 15-minute access token expiring, and charging a delay for that would cost every user a gap every 15 minutes. The caller must therefore reset the counter on a successful connection. The 5 s ceiling is set by SC-007, not taste: after a 5-minute outage the client sits at the ceiling, so the delay alone must leave room inside the 10 s recovery budget. Jitter is deliberately absent — T042 adds it on top, keeping this function pure and its tests free of a stubbed generator
- [X] T018 Implement the stream reader in `apps/web/services/event-stream.ts`: open via `apiFetch` so the `Authorization` header and refresh-on-401 are reused, consume `response.body`, dispatch parsed events, and reopen on close — a 15-minute access token makes reconnection routine, not exceptional. Returns a stop function **synchronously**, so a caller has something to hold before the first connection resolves. Decoding goes through `pipeThrough(new TextDecoderStream())` rather than a hand-held `TextDecoder`, which makes forgetting `{ stream: true }` structurally impossible — without it a chunk boundary landing mid-character splits a Cyrillic exercise name into replacement chars and the JSON then fails to parse. `response.ok` is checked before reading, so the 429/503 distinction T010 builds is not thrown away by reading an error body as if it were a stream. **What clears the backoff is how long a connection lasted, not whether it opened**: an earlier draft reset on connect, and a behavioural test caught it reopening 123 times in 150 ms against a server that accepts and immediately closes — precisely the tight loop FR-022 forbids. Heartbeat frames get their own `onHeartbeat` hook as a seam for T043
- [ ] T019 Replace `apps/web/services/workout-events.ts` with a server-fed store: same external-store shape (`revision` + `useSyncExternalStore`) so existing call sites change minimally, now fed by both stream events and locally originated changes
- [ ] T020 [P] Unit-test the store's convergence properties in `apps/web/services/workout-events.spec.ts` (FR-020): the same `event_id` delivered twice leaves the same end state as delivering it once, and two notifications applied in either order converge on the same state. Thin payloads make this true by construction — the test exists so a future change that starts carrying data cannot break it silently

**Checkpoint**: `curl -N -H "Authorization: Bearer …" localhost:3000/api/events`
holds open and emits heartbeats; a manual `redis-cli PUBLISH` to the user's
channel appears in it. No UI change yet.

---

## Phase 3: User Story 1 — Watching a logged workout land (P1) 🎯 MVP

**Goal**: A logged workout appears in the in-flight surface, then leaves it and
appears among the settled workouts when processing finishes — no reload.

**Independent Test**: Log a workout with the date field blank and a date in the
text. It must appear in the in-flight modal, be absent from the lists, then
within ~3s move to the history and to its week on the dashboard, which follows
it. See [quickstart.md](./quickstart.md) scenarios 1–3.

### Producing the notification

- [ ] T021 [US1] Publish `workout.settled` (status `parsed` or `needs_review`, with the post-parse `performed_at`) after the transaction commits in `apps/worker/src/parser/handler.ts`, alongside the existing `workout.parsed` publish — best-effort, never failing the ack
- [ ] T022 [US1] Publish `workout.settled` with status `failed` from the non-retryable and retries-exhausted paths in `apps/worker/src/parser/retry.ts`, after `markWorkoutFailed`
- [ ] T023 [P] [US1] Unit-test both publish paths in `apps/worker/tests/integration/parser.spec.ts`: a settled notification is emitted with the workout's current `performed_at`, and a publish failure does not fail processing

### Querying by settled status

- [ ] T024 [US1] Change `status` from a scalar to a repeatable value in `apps/api/src/workouts/dto/list-workouts-query.dto.ts`, validating each against `WorkoutStatus` and collapsing duplicates
- [ ] T025 [US1] Apply it as `w.status IN (:...statuses)` in `apps/api/src/workouts/workouts.service.ts`, keeping single-value and absent behaviour identical
- [ ] T026 [P] [US1] Extend `apps/api/tests/contract/workouts.list.spec.ts`: single `?status` unchanged; repeated `?status` returns the union; unknown value → 400; absent returns all statuses

### The two surfaces

- [ ] T027 [P] [US1] Filter the dashboard's weekly list to `?status=parsed&status=needs_review` in `apps/web/features/dashboard/weekly-workouts.tsx`, keeping the existing request-sequencing guard
- [ ] T028 [P] [US1] Filter the workout history the same way in `apps/web/features/workouts/workout-list.tsx`, preserving across refetches everything FR-017 names: the page being viewed, scroll position, and any row the user has expanded — an expanded row must not collapse because an unrelated workout settled
- [ ] T029 [US1] Build the in-flight modal (portal-rendered; processing items, failed items with an explanation, and an explicit "nothing in progress" state) in `apps/web/features/in-flight/`, sourced from `?status=pending&status=failed` per [contracts/ui.md](./contracts/ui.md)
- [ ] T030 [US1] Open the modal from the logging control and show the in-flight count on it while closed, in `apps/web/components/log-workout-button.tsx` — without this, closing the modal makes in-progress work invisible (FR-013)
- [ ] T031 [US1] Implement dismiss for failed items in `apps/web/features/in-flight/` via `DELETE /workouts/:id`, wording it as deletion rather than hiding (FR-014)

### Reacting to the notification

- [ ] T032 [US1] On `workout.settled`, move the workout between surfaces: refetch the in-flight list and, when `performed_at` falls in the displayed week, the weekly list — in `apps/web/services/workout-events.ts`'s successor and its consumers
- [ ] T033 [US1] Implement the single permitted navigation in `apps/web/features/dashboard/`: only the session that logged the workout moves the dashboard to the week it settled into, only for `parsed`/`needs_review`, and only when that week differs from the one on screen (FR-018, [contracts/ui.md](./contracts/ui.md))
- [ ] T034 [US1] Ensure an arriving notification never discards work in progress (FR-021): a partially filled logging form in `apps/web/components/log-workout-form.tsx` MUST keep its values when the store's `revision` changes, and opening or refreshing the in-flight modal MUST NOT remount or reset it. The risk is concrete — T029 and T030 attach the modal to the same control that hosts the form

**Checkpoint**: US1 is independently demonstrable — quickstart scenarios 1–3
pass. This is the MVP.

---

## Phase 4: User Story 2 — Weekly analytics stay current (P2)

**Goal**: Recomputed volume figures appear on an open dashboard without a reload.

**Independent Test**: With the dashboard open on a week, cause that week's volume
to be recomputed; the figures change while the dashboard stays on that week.
Quickstart scenario 2.

- [ ] T035 [US2] Publish the `analytics.updated` notification **after** the Redis pipeline `exec()` commits in `apps/worker/src/analytics/handler.ts`, carrying `iso_week` (a deletion recomputes a week whose workout is gone, so the week cannot be derived) — announcing a recomputation that could still fail would race clients into refetching stale figures. No RabbitMQ event and no new binding: the type is already in the T004 union
- [ ] T036 [P] [US2] Test in `apps/worker/tests/integration/analytics.spec.ts` that the notification is published after the hash is written, for both the parsed and the deleted paths
- [ ] T037 [US2] Refetch the volume chart on `analytics.updated` whose `iso_week` matches the displayed week, ignoring all others, in `apps/web/features/dashboard/volume-chart.tsx`

**Checkpoint**: US2 works on top of US1 but is verifiable on its own.

---

## Phase 5: User Story 3 — Every open session agrees (P3)

**Goal**: A change in one session or device becomes visible in the others.

**Independent Test**: Two sessions, same user. A change in one appears in the
other; the second never changes week. Quickstart scenarios 5–6.

- [ ] T038 [P] [US3] Publish `workout.created` (with `performed_at`) after `POST /workouts` commits, in `apps/api/src/workouts/workouts.service.ts`
- [ ] T039 [P] [US3] Publish `workout.deleted` (with the date the workout had) after `DELETE /workouts/:id` commits, in `apps/api/src/workouts/workouts.service.ts` — this also covers dismissal from T031
- [ ] T040 [P] [US3] Extend `apps/api/tests/contract/workouts.create.spec.ts` and `workouts.delete.spec.ts` to assert the notification is published, and that a publish failure does not fail the request (FR-030)
- [ ] T041 [US3] Ensure a session that did not log the workout never navigates on `workout.settled` — it refreshes in place only (FR-018, US3 scenario 3) — in `apps/web/features/dashboard/`

**Checkpoint**: Multi-session behaviour verifiable; needs two replicas for the
full check (quickstart scenario 5).

---

## Phase 6: User Story 4 — Interruptions leave no stale data (P3)

**Goal**: A dropped, idle, or unavailable channel never leaves stale data
presented as live, and never blocks the app.

**Independent Test**: Sever connectivity, change data, restore. The screen
converges within ~10s. Quickstart scenario 4.

- [ ] T042 [US4] Apply the T017 backoff with jitter to reconnection in `apps/web/services/event-stream.ts`, including a bounded give-up that leaves the app usable
- [ ] T043 [US4] Derive liveness from the heartbeat — no traffic for more than two intervals means not healthy, regardless of socket state (FR-025) — in `apps/web/services/event-stream.ts`
- [ ] T044 [US4] Expose `connecting | live | offline` from the store per [data-model.md](./data-model.md) and consume it where screens need it
- [ ] T045 [P] [US4] Apply the offline rules from [contracts/ui.md](./contracts/ui.md): never an error state, never blocking, never presenting stale data as live, and the in-flight modal still fetches on open
- [ ] T046 [US4] On reconnect, bump the store's `revision` in `apps/web/services/workout-events.ts`'s successor so every mounted consumer refetches what it displays — changes made during the outage must not be permanently invisible (FR-023)

**Checkpoint**: All four stories complete.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T047 [P] Record the two research findings as code comments citing their source, per Constitution Principle V: CloudFront's 30s default behind the 15s heartbeat in `apps/api/src/events/events.controller.ts`, and why fan-out avoids the RabbitMQ work exchange in `apps/api/src/events/notifications.subscriber.ts`
- [ ] T048 [P] Add structured log lines for channel lifecycle and delivery — opened, closed, published, dropped, cap-refused — via the existing loggers, never `console.log` (FR-029)
- [ ] T049 Run scenarios 1–4 from [quickstart.md](./quickstart.md) locally and fix what they surface
- [ ] T050 Run scenario 5 from [quickstart.md](./quickstart.md) against `infra/docker-compose.prod.yml` (two replicas behind Caddy) — the fan-out bug this catches cannot occur with a single API process
- [ ] T051 Run scenario 6 from [quickstart.md](./quickstart.md) (cross-user isolation), asserting on the raw event stream rather than the rendered UI
- [ ] T052 Verify SC-010 — measure `GET /api/health` latency (baseline), hold 200 concurrent `/api/events` connections open with a throwaway Node script, measure again, and confirm the degradation stays under 10%. Also confirm memory does not grow while connections merely idle, and that closing all 200 empties the connection registry (FR-027). Record the numbers in [quickstart.md](./quickstart.md) scenario 7; if the target is missed, that is a finding to raise, not a number to quietly adjust
- [ ] T053 [P] `npm run lint && npm run format:check && npm test` from the root, with the dev worker stopped (its RabbitMQ race with the ingestion integration test is known, not a regression)

---

## Phase 8: Ingest durability

**Why this is in *this* spec**: `IngestionService.ingest` performs four writes
across three systems — GridFS, `raw_uploads`, the `workouts` row, then a
RabbitMQ publish — with no atomicity between them. That predates this feature,
but this feature is what makes the worst case visible. A workout whose
`workout.uploaded` publish is lost never reaches a terminal status, so before
spec 004 it sat in a list wearing a grey badge, and after it sits in the
in-flight modal **forever** — which SC-012 forbids ("zero workouts remain in
the in-flight surface after processing has reached a terminal outcome").

The publish is not merely untransactional, it is unconfirmed:
`rabbitmq-publisher.service.ts:18` uses `createChannel()` rather than
`createConfirmChannel()`, and `publish()` is synchronous and returns `void`. A
dropped connection loses the event with no exception raised anywhere.

**Three increments, deliberately overlapping.** Each is useful alone; together
they are defence in depth. They can ship independently of the user stories.

### Increment 1 — compensating action (closes both failure halves, cheaply)

- [ ] T054 Switch `apps/api/src/events/rabbitmq-publisher.service.ts` to `createConfirmChannel()` and make `publish()` async and awaited, so a broker that never acknowledges raises instead of silently dropping. Note this alone makes things *worse* without T055: the workout row is already saved when the publish fails, so a client retry would create a duplicate
- [ ] T055 Wrap the write sequence in `apps/api/src/workouts/ingestion.service.ts` so a failure after the Mongo writes deletes what it created (GridFS blobs, the `raw_uploads` doc, the `workouts` row) and returns `503`. The user then sees either "it worked" or "it failed" — never a half-written workout. **This is a compensating action, not a saga**: one method drives the whole sequence and its undo, with no second participant and no messages between steps. If anything, that makes it orchestration; the project's actual choreography is `workout.uploaded → parser → workout.parsed → analytics`, where nobody holds the overall picture
- [ ] T056 Integration test in `apps/api/tests/integration/ingestion.service.spec.ts`: with the publish forced to fail, no `workouts` row, no `raw_uploads` doc and no GridFS blob survive, and the caller gets `503`. Decide and record what happens when the compensation *itself* fails — logging and accepting the orphan is a legitimate answer, but it must be a stated one

### Increment 2 — transactional outbox (turns "almost always" into a guarantee)

- [ ] T057 Add an `outbox` table (event id, routing key, payload, `occurred_at`, `published_at`) plus its entity and a TypeORM migration under `packages/shared/src/db/migrations/`, following the existing `<timestamp>-<Name>.ts` convention
- [ ] T058 In `ingestion.service.ts`, write the `workouts` row and the outbox row inside **one Postgres transaction**, and stop publishing from the request path. This is what Constitution Principle IV asks for almost verbatim — "an event that drives work MUST be published only after the state it describes has committed" — made structurally impossible to violate rather than merely observed
- [ ] T059 Add a relay that reads unpublished outbox rows, publishes them with confirms (T054), and marks them sent. At-least-once delivery is already safe here: `withEventIdempotency` and the `processed_events` table exist, so consumers tolerate duplicates — this is half the usual cost of an outbox, already paid by spec 001
- [ ] T060 Integration test: with RabbitMQ stopped, `POST /workouts` still succeeds and the row lands in `outbox`; once the broker returns, the relay publishes it and the workout parses. This is the guarantee T054/T055 cannot give — there, a broker outage means the request fails

### Increment 3 — reconciliation sweep (the net under both)

- [ ] T061 Add a periodic sweep that finds `pending` workouts older than a chosen threshold and re-publishes `workout.uploaded` for them. Duplicates are harmless (see T059). Choose the threshold against the parser's real latency, not a round number, and record the reasoning
- [ ] T062 Integration test: a workout left `pending` past the threshold gets re-published exactly once per sweep and reaches a terminal status; one inside the threshold is left alone

**What Increment 2 makes redundant**: T058 removes the publish from the request
path, so T055's publish-failure branch becomes dead code and should be deleted
then. The Mongo-orphan half of T055 stays — an outbox spans one database, not
two, and nothing about it helps if the Postgres transaction fails after the
GridFS write. Doing these in order means knowingly writing something that is
later partly removed; that is accepted here because each increment is meant to
stand on its own and to be readable as one idea.

---

## Dependencies

**Phase order**: Setup → Foundational → US1 → US2 → US3 → US4 → Polish.

**Hard blockers**:

- T003 (spike) blocks T010 — the endpoint's implementation shape depends on it.
- T004 blocks everything that references the notification type (T007, T009, T015, T021).
- T011 blocks the contract tests T012–T014.
- T018/T019 block every story's client-side reaction.
- T019 blocks T020 — the convergence test asserts on the store it creates.
- T052 (SC-010 measurement) needs the whole channel working, so it runs last; against the two-replica stack if the production figure is wanted.
- T054 blocks T055 — the compensation has nothing to react to until a failed publish actually raises.
- T057 blocks T058, which blocks T059. T059 supersedes T055's publish branch.
- Phase 8 depends on none of the user stories and none of them depend on it. It can ship before, after, or between them; only SC-012's honesty depends on it landing eventually.
- T024 blocks T025, which blocks T027, T028, T029.
- T017 (pure backoff) blocks T042 (applying it).
- T031 (dismiss) and T039 (`workout.deleted` publish) touch the same delete path — sequence them.

**Story independence**: US2, US3 and US4 each depend on Phase 2 but not on each
other. US1 must land first only because it delivers the surfaces the others
update; the notification types they need are all defined in T004.

## Parallel Execution Examples

**Phase 2** — after T004 and T005, these are independent files:

```
T006  packages/shared/src/db/redis.ts
T007  apps/api/src/events/notifications.publisher.ts
T008  apps/api/src/events/connection-registry.ts
T015  apps/web/services/event-stream.ts   (parser)
```

**Phase 2 contract tests** — after T011, three separate spec files:

```
T012  events.auth.spec.ts
T013  events.delivery.spec.ts
T014  events.limits.spec.ts
```

**Phase 3** — after T025, the two list filters are separate components:

```
T027  apps/web/features/dashboard/weekly-workouts.tsx
T028  apps/web/features/workouts/workout-list.tsx
```

**Phase 5** — T038 and T039 are separate methods; T040's two spec files are
independent.

## Implementation Strategy

**MVP = Phase 1 + Phase 2 + Phase 3 (US1)** — T001–T034. That delivers the gap
this feature exists to close: a logged workout resolves on screen without a
reload, and the dashboard's list and chart stop disagreeing.

**Why the infrastructure comes first and is user-invisible**: Phases 1–2 change
nothing a user can see. That is deliberate — the risky parts (SSE under Fastify,
cross-replica fan-out, auth on a long-lived connection) are proven with `curl`
and contract tests before any UI depends on them. A failure in Phase 2 is a
localized problem; the same failure discovered during Phase 3 is entangled with
UI work.

**Increments after the MVP**: US2 (live analytics) is the highest value per
task. US3 and US4 harden rather than extend, and either may ship independently.

**Deferred by the spec, not forgotten**: retrying a failed workout is out of
scope here — dismissal (T031) exists so the user is never stuck. DOM-level
component testing likewise stays out; T002 sets up pure-logic testing only.
