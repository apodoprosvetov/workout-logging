# Research: Real-Time Updates

**Feature**: 004-realtime-updates | **Date**: 2026-09-09

Eleven decisions. The first four were settled with the user by walking the
alternatives explicitly; #5 is the design change that removed a conflict rather
than resolving it. The rest fall out of those.

---

## 1. Transport: Server-Sent Events

**Decision**: SSE — one long-lived `GET /api/events` per open screen, streaming
`text/event-stream`.

**Rationale**: The requirement is strictly one-directional (spec Assumptions,
"the channel is one-directional"). SSE is plain HTTP, so it rides the
CloudFront behaviour that already exists for `/api/*` (`infra/terraform/
cloudfront.tf:97-108` — `GET` allowed, caching disabled, all viewer headers
forwarded) and Caddy proxies it as an ordinary request with no upgrade
handling. Zero infrastructure change is a real advantage on this stack, where
the API sits behind both a CDN and a load balancer.

**Alternatives considered**:

- *WebSocket*: needs `@nestjs/websockets` plus an adapter, a second
  authentication path outside `JwtAuthGuard`, and its own reconnect logic — all
  to buy a client→server direction the spec explicitly does not want. Worth
  revisiting only if live editing is ever added.
- *Periodic polling*: no new infrastructure, but SC-001's 3-second target means
  ~1200 requests/hour per open tab against two replicas, and it scales with tabs
  rather than with changes. Rejected on SC-010 (200 concurrent channels without
  degrading ordinary request latency).

## 2. Fan-out across API replicas: Redis Pub/Sub

**Decision**: `apps/worker` publishes each notification to a Redis channel keyed
by user; every API replica subscribes and forwards to the SSE connections it
happens to hold.

**Rationale**: This is the constraint that shapes the whole backend design.
`infra/Caddyfile` round-robins between `api-1` and `api-2`, so a user's SSE
connection lives on exactly one replica while the event is produced by a worker
that holds no client connections at all. Something has to bridge them.

Redis is already in both compose files and `ioredis` is already an `apps/api`
dependency; `apps/worker` already carries a `redis` client in its
`WorkerContext` (`apps/worker/src/index.ts:22`). Pub/Sub's "delivered to whoever
is listening right now, dropped otherwise" semantics are exactly FR-027, not a
limitation to work around.

**Alternatives considered**:

- *A per-replica exclusive RabbitMQ queue bound to `workout.events`*: genuinely
  close, and tempting because `workout.parsed` and `workout.deleted` are already
  published to that exchange — half the producer work is done. Rejected because
  it puts ephemeral UI notifications on the same topology as durable work that
  has retry tiers and a DLQ (`packages/shared/src/events/rabbitmq.ts:58-84`). A
  slow replica would accumulate a queue until auto-delete, and a notification
  concern would become entangled with redelivery machinery whose subtleties are
  already documented as hard-won (see the `isDeletion` comment in
  `apps/worker/src/analytics/handler.ts`). Keeping the notification path
  independent of the work path is worth more than reusing the exchange.

## 3. Channel authentication: fetch-based SSE with the Authorization header

**Decision**: The client opens the stream with `fetch` + `ReadableStream` rather
than the native `EventSource`, sending the access token in the `Authorization`
header exactly as every other request does. Reconnection and backoff are
implemented in the client module.

**Rationale**: Access tokens live 15 minutes (`apps/api/src/auth/auth.module.ts:29`)
while a channel should live for hours, so re-authentication is unavoidable
whatever we choose. `EventSource` cannot set headers, which forces the token
into the URL — and CloudFront and Caddy both log request lines, so that is a
real regression against the current header-only scheme.

Going through `fetch` means the stream reuses `apiFetch`'s existing
refresh-on-401-and-retry logic (`apps/web/services/api-client.ts`), including
its in-flight refresh dedupe, instead of duplicating it. The same
`JwtAuthGuard` protects the endpoint with no special case.

**Alternatives considered**:

- *One-time ticket + native `EventSource`*: exchange a Bearer token for a
  short-lived single-use ticket, then stream with the native object. Its
  advertised benefit is free reconnection — but the browser reconnects to the
  *same URL* with the now-spent ticket, so reconnection has to be intercepted
  and driven manually anyway. The benefit evaporates and two moving parts (a
  ticket endpoint, a Redis key) remain.
- *JWT in the query string*: least code, but puts a live credential in
  CloudFront access logs, Caddy logs, and browser history. Rejected outright.

## 4. Payload: thin notification plus the workout's date

**Decision**: Events carry identity and addressing only — which workout, what
status, `performed_at`, which week — and the client refetches through the
existing REST endpoints.

**Rationale**: One authorization boundary and one serialization of the read
model. It also makes FR-020 hold almost for free: if an event carries no data,
a duplicate or out-of-order delivery cannot overwrite anything, it just triggers
a redundant refetch.

`performed_at` is the one field beyond bare identity, added at the user's
request, and it is addressing rather than payload — the same role `week` plays
in the analytics event. Without it a dashboard cannot tell whether a settling
workout concerns the week it is showing without fetching first, which is the
round trip the thin design is trying to avoid. It also closes the gap
`apps/web/services/workout-events.ts` documents as unreachable: "the parser
worker may later move the workout to a date it found in the text … Following it
afterwards is the live-updates problem, deferred by FR-013."

The *old* date is deliberately not carried. A screen showing the previous week
already holds the workout and recognises it by id; a screen showing the new week
never had it. Neither needs the prior value.

**Alternatives considered**:

- *Full workout payload*: saves a round trip, but duplicates the read-model
  serialization into the event path, requires authorization decisions in two
  places, and makes out-of-order delivery dangerous — an older event would
  overwrite newer state. The event would also grow with the read model.

## 5. Where an unsettled workout lives (the conflict this removed)

**Decision**: The dashboard's weekly list and the workout history show only
`parsed` and `needs_review`. `pending` and `failed` live in a modal in-flight
surface opened from the logging control, which carries a count while closed.

**Rationale**: Two specs collided here. Spec 003 FR-012 says the dashboard
switches to the week a logged workout belongs to; this spec's FR-017/FR-018 say
an update must never navigate the user. Both fire when the parser moves a
workout's date, which it does whenever the user left the date blank and the
submitted text contains one (`apps/worker/src/parser/handler.ts:184`).

Rather than pick a compromise — silently vanishing a row, or yanking the user to
another week — the design removes the situation: a workout that is not settled
is never displayed inside a week, so a date discovered during processing cannot
disturb anything on screen.

It also fixes a defect that predates this feature. `computeWeeklyVolume` filters
`w.status IN ('parsed','needs_review')` (`packages/shared/src/analytics.ts:82`),
while `WorkoutTable` renders every status — so today the dashboard's weekly list
and the volume chart beside it already describe the same week differently. FR-010
and SC-004 close that.

The week-switch from spec 003 FR-012 survives, narrowed: only the session that
logged the workout follows it, and only when it settles — a moment when the user
is looking at the in-flight surface tracking that very workout, so a move is the
completion of their action rather than an interruption.

**Alternatives considered**: keeping unsettled workouts in the lists and either
(a) removing the row silently, or (b) switching weeks automatically. (a) makes
work disappear with no explanation; (b) violates FR-018 and can pull a reader
off the week they were studying. A third option — a toast offering "jump to the
new week" — was rejected for this increment because the project has no
toast/banner primitive at all, making it a new UI concern rather than a branch
in existing logic.

## 6. Failed workouts: dismiss, don't retry

**Decision**: A failed workout stays in the in-flight surface until the user
dismisses it; dismissal deletes it. No retry in this feature.

**Rationale**: Failure is currently a dead end — `markWorkoutFailed` sets the
status (`apps/worker/src/parser/retry.ts`) and the UI shows a red badge with no
action attached. Dismissal is the minimum that makes the state honest and
bounded: the user is never stuck, and the surface cannot fill with corpses.

Retry is worth building — the original upload is still in GridFS, so there is
something to resubmit — but it needs a resubmission path, an attempt cap, and a
story for repeated failure. That is its own increment, and bundling it here
would expand this feature well past the update channel that motivates it.

## 7. The analytics recomputation announces nothing today

**Decision**: Add `analytics.updated` to the shared event contracts, published by
the analytics consumer after the Redis hash is written.

**Rationale**: FR-002 cannot be satisfied otherwise. `workout.parsed` and
`workout.deleted` already exist and are published
(`apps/worker/src/parser/handler.ts:52`, `apps/api/src/workouts/workouts.service.ts:146`),
but the analytics handler recomputes the week and writes Redis without telling
anyone (`apps/worker/src/analytics/handler.ts`). The notification must be
published *after* the pipeline `exec()` commits, for the same reason the parser
publishes only after its transaction commits — announcing a state that could
still fail would race the client into refetching stale figures.

## 8. The list endpoint cannot express "settled"

**Decision**: Extend `GET /workouts`'s `status` filter to accept multiple values.

**Rationale**: FR-009 needs `status IN ('parsed','needs_review')` in one query.
Today the filter is single-valued — `qb.andWhere('w.status = :status', …)`
(`apps/api/src/workouts/workouts.service.ts:48`) with a scalar DTO field
(`apps/api/src/workouts/dto/list-workouts-query.dto.ts:17`). The in-flight
surface needs the complementary query, so both callers benefit from one change.
Repeated query params (`?status=parsed&status=needs_review`) keep the existing
parameter name and stay backward compatible with a single value.

## 9. Heartbeat interval: 15 seconds

**Decision**: Emit an SSE comment line every 15 seconds on an idle stream.

**Rationale**: `infra/terraform/cloudfront.tf:69-74` sets no
`origin_read_timeout`, so CloudFront's default of 30 seconds applies between
packets. An idle stream is silently cut at 30s without it — precisely the
silent death FR-024 forbids. 15s gives two chances inside every window. The
heartbeat doubles as the client's liveness signal for FR-025: no traffic for
more than two intervals means the channel is not healthy, whatever the socket
claims.

## 10. Connection registry and limits

**Decision**: Each replica keeps an in-memory map of userId → set of open
responses, and refuses a new stream beyond a per-user cap.

**Rationale**: FR-028 exists because one user with many tabs must not exhaust
capacity for everyone. The registry is per-replica and deliberately not shared:
it describes sockets this process owns, which is not information another replica
can act on. That means the cap is per-replica rather than global — acceptable,
because the goal is protecting a process from exhaustion, not exact accounting.

Cleanup must be driven by the connection's own close event rather than by a
sweep, so a client that vanishes without a FIN does not leak an entry (FR-027).

## 11. Verification approach

**Decision**: Contract tests for the new and changed API surface in
`apps/api` (vitest), a unit test for the client's SSE frame parsing and
reconnect/backoff, and a manual end-to-end walkthrough in `quickstart.md` for
the multi-session and interruption scenarios.

**Rationale**: The standing instruction is to contract-test every new
`apps/api` route, which covers `GET /api/events` and the changed `GET /workouts`
filter. The parts hardest to get right — frame parsing across chunk boundaries,
backoff, giving up — are pure functions of a byte stream and belong in unit
tests. What cannot be automated cheaply here is genuine multi-replica behaviour:
`apps/web` has no test runner configured at all, and the fan-out only exists
with two replicas plus a worker. Those go in `quickstart.md` as scripted manual
checks, consistent with how earlier specs verified infrastructure behaviour.

**Note**: `@Sse()` in Nest is documented for both adapters, but this project runs
Fastify (`apps/api/src/main.ts:14`) and the decorator's behaviour there —
particularly flushing and client-disconnect detection — should be confirmed by a
spike before the endpoint is built out. If it misbehaves, the fallback is
writing to `reply.raw` directly, which is a contained change to one controller.
