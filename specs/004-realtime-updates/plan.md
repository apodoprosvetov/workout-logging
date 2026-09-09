# Implementation Plan: Real-Time Updates

**Branch**: `004-realtime-updates` | **Date**: 2026-09-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-realtime-updates/spec.md`

## Summary

Give open screens a server-to-client channel so a workout's processing outcome
and a week's recomputed volume appear without a reload — the gap spec 003
deferred in its FR-013.

The approach: `apps/worker` and `apps/api` publish thin change notifications to
a per-user Redis Pub/Sub channel; every API replica subscribes and forwards to
the SSE connections it holds; `apps/web` consumes the stream over `fetch` and
refetches through the REST paths that already exist.

Alongside it, one design change that the feature made unavoidable: the lists
show only settled workouts (`parsed`, `needs_review`), while `pending` and
`failed` move to an in-flight modal. This removes a conflict between spec 003's
week-switching rule and this spec's "never navigate the user" rule, and it fixes
a pre-existing inconsistency where the dashboard's weekly list counts workouts
its volume chart does not.

## Technical Context

**Language/Version**: TypeScript 5.6, Node ≥22 (workspace-wide)

**Primary Dependencies**: NestJS 11 on Fastify (`apps/api`), Next 16 static
export + React 19 (`apps/web`), amqplib + TypeORM + Mongoose (`apps/worker`),
`ioredis` in both api and worker. No new runtime dependency is required.

**Storage**: No schema change. Postgres (`workouts`), Redis (weekly volume
hashes; now also Pub/Sub), MongoDB/GridFS (raw uploads) all unchanged.

**Testing**: `vitest` in `apps/api` and `apps/worker`. `apps/web` has **no test
runner configured** — see Risks.

**Target Platform**: Browser client (static export on S3/CloudFront) against a
containerised API on a single EC2 instance behind Caddy.

**Project Type**: Web application — npm workspaces monorepo, three apps plus a
shared package.

**Performance Goals**: Notification visible within 3s at p95 (SC-001, SC-002,
SC-006); ≥200 concurrent channels without degrading ordinary request latency by
more than 10% (SC-010).

**Constraints**:

- Two API replicas behind round-robin (`infra/Caddyfile`) — a notification must
  reach the replica holding the connection, which no single process can
  guarantee alone.
- CloudFront sets no `origin_read_timeout`, so its 30s default cuts an idle
  stream; heartbeat must be well inside it.
- Access tokens live 15 minutes while channels live hours — reconnection is
  routine, not exceptional.
- `apps/web` is a static export: no server runtime, so the browser talks to
  `/api` directly.

**Scale/Scope**: Single-instance deployment, small user base. ~2 new API
surfaces, 1 new worker publish path, 1 new UI surface, 1 replaced web module.

## Constitution Check

Evaluated against `.specify/memory/constitution.md` **v1.0.0**, ratified
2026-09-09 — after this plan was first written, so this section was revised to
check against the real gates rather than the standing rules used originally.

| Principle | Status | Evidence |
|---|---|---|
| **I. Spec-Driven Change** | Pass | Spec states no transport or framework; all four transport/fan-out/auth/payload decisions were put to the maintainer before being made; `research.md` records rejected alternatives for each. The spec was amended when the in-flight-surface design invalidated US1, with the reason recorded in `checklists/requirements.md` — the "do not let the two drift" clause. |
| **II. Verified Against Real Infrastructure** | Pass | `GET /api/events` and the changed `GET /workouts` filter have contract tests enumerated in [contracts/api.md](./contracts/api.md), running against real containers. The `apps/web` testing gate is closed — see below. |
| **III. One Definition, Enforced Boundaries** | Pass | The notification envelope has one definition in `packages/shared`, compiled against by the `apps/worker` producer and the `apps/api` consumer. `apps/web` consumes only HTTP. No HTTP surface added to `apps/worker`. |
| **IV. Events Durable, Notifications Not** | Pass | `analytics.updated` publishes only after the Redis pipeline commits, matching the existing parser rule. Notifications are explicitly best-effort and cannot fail the underlying change (FR-030, restated in [contracts/events.md](./contracts/events.md) §3). Thin payloads make duplicate and out-of-order delivery harmless (FR-020), which is idempotency by construction. |
| **V. The Code Records Why** | Pass by obligation | An implementation-time duty, not a design property. Two findings in `research.md` MUST reach the code as comments citing their source: the 30s CloudFront default behind the 15s heartbeat (#9), and why fan-out avoids the RabbitMQ work exchange (#2). |

**Operational Constraints**: all respected. The Redis Pub/Sub fan-out exists
precisely because no design may assume a connection belongs to a given replica.
The `?status` change is additive and backward compatible, so adjacent versions
coexist during a rolling deploy. No new datastore and no paid AWS component —
Redis is already in both compose files. `FR-029` covers structured logging, and
the CDN's 30-second origin read timeout is named where it is relied upon, as the
constraint requires.

### Principle II gate — decision recorded

The constitution requires a feature placing non-trivial logic in `apps/web` to
decide explicitly whether to close the no-test-runner gap or accept it. This
feature does place such logic there: SSE frame parsing across chunk boundaries,
reconnect backoff, and the week-relevance rule that decides whether a
notification concerns what is on screen.

**Decision: close the gap.** `apps/web` gets `vitest`, and the logic above is
written as pure modules and unit-tested.

**Why this rather than accepting the gap**: the cost turned out to be near zero,
which inverted the trade-off. `apps/worker` runs `vitest` with nothing but the
dependency and a nine-line config (`environment: 'node'`, no plugins) — and
that is a sufficient template here, because none of the logic in question
touches React or the DOM. Frame parsing is a function from a byte stream to
events; backoff is a function from an attempt number to a delay; week relevance
is a function of two dates. No jsdom, no React Testing Library, no component
rendering.

That also means the mitigation that made "accept the gap" tempting — keep the
logic in small pure functions — is not an alternative to testing it. It is the
precondition that makes testing it cheap, so the plan adopts both.

**Scope of the decision**: unit tests for pure logic only. Component behaviour,
hooks, and rendering stay uncovered by automated tests and remain the job of the
`quickstart.md` scenarios. Introducing DOM-level testing to this project is a
larger question and is deliberately not settled here.

**Concrete obligations** this places on `/speckit-tasks`:

- Add `vitest` to `apps/web` devDependencies and a `test` script, so the root
  `npm test` (`--workspaces --if-present`) picks it up with no other change.
- Add `apps/web/vitest.config.ts` mirroring `apps/worker`'s, with the tsconfig
  path aliases (`@services/*`, `@lib/*`, …) resolvable — or keep test imports
  relative and skip alias configuration entirely.
- Ship `event-stream.ts`'s parser and backoff as exported pure functions with
  tests covering: an event split across two chunks, two events in one chunk,
  a heartbeat comment line, a malformed frame, and backoff growth with a cap.

## Project Structure

### Documentation (this feature)

```text
specs/004-realtime-updates/
├── plan.md              # This file
├── spec.md              # Amended after the in-flight-surface decision
├── research.md          # Phase 0 — 11 decisions
├── data-model.md        # Phase 1 — no persistent schema
├── quickstart.md        # Phase 1 — validation scenarios
├── contracts/
│   ├── api.md           # GET /api/events; repeatable ?status
│   ├── events.md        # analytics.updated + the notification envelope
│   └── ui.md            # the settled/in-flight partition
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 — created by /speckit-tasks, not here
```

### Source Code (repository root)

```text
packages/shared/src/
├── events/
│   ├── types.ts               # + ANALYTICS_UPDATED_ROUTING_KEY, AnalyticsUpdatedEvent
│   ├── rabbitmq.ts            # + binding for analytics.updated
│   └── notifications.ts       # NEW — ChangeNotification union, channel-name helper
└── db/redis.ts                # + a subscriber-mode client factory

apps/api/src/
├── events/
│   ├── rabbitmq-publisher.service.ts   # unchanged
│   ├── notifications.publisher.ts      # NEW — publish to Redis Pub/Sub
│   ├── notifications.subscriber.ts     # NEW — subscribe, route to local connections
│   ├── connection-registry.ts          # NEW — userId → open streams, per-replica cap
│   ├── events.controller.ts            # NEW — GET /api/events (SSE)
│   └── events.module.ts                # wire the above
└── workouts/
    ├── workouts.service.ts             # ?status IN (…); publish created/deleted
    └── dto/list-workouts-query.dto.ts  # status: scalar → array

apps/worker/src/
├── parser/handler.ts          # + publish workout.settled (parsed | needs_review)
├── parser/retry.ts            # + publish workout.settled (failed)
└── analytics/handler.ts       # + publish analytics.updated after the pipeline commits

apps/web/
├── services/
│   ├── workout-events.ts      # REPLACED — same store shape, server-fed
│   ├── event-stream.ts        # NEW — fetch-based SSE reader; parser + backoff
│   │                          #       exported as pure functions
│   └── event-stream.spec.ts   # NEW — unit tests for those pure functions
├── features/
│   ├── in-flight/             # NEW — modal, list, dismiss, count badge
│   ├── dashboard/             # settled-only filter; week-follow rule
│   └── workouts/              # settled-only filter
├── components/
│   └── log-workout-button.tsx # + in-flight count, opens the modal
├── vitest.config.ts           # NEW — mirrors apps/worker's (node env)
└── package.json               # + vitest devDependency, + test script
```

**Structure Decision**: existing monorepo layout, no new package. The shared
notification type goes in `packages/shared` because both a producer
(`apps/worker`) and a consumer (`apps/api`) must agree on it — the same reason
the RabbitMQ event types live there. The new `apps/web/features/in-flight/`
follows the established `features/<domain>/` convention.

## Implementation Order

Each stage is independently verifiable, and the first three deliver no
user-visible change — deliberately, so the risky infrastructure is proven before
any UI depends on it.

1. **Notification contract** — the shared types and channel-name helper. No
   behaviour.
2. **Publish path** — producers emit notifications; verify with `redis-cli
   PSUBSCRIBE 'user-events:*'` while using the app. Nothing consumes them yet.
3. **`GET /api/events`** — the endpoint, registry, and subscriber. Verify with
   `curl -N`. Contract tests land here, including cross-user isolation.
4. **Client channel** — `event-stream.ts` and the replacement store. Screens
   refetch on notification; no layout change yet. This is where US1 first
   becomes demonstrable end to end.
5. **Settled/in-flight split** — the `?status` change, the modal, the count
   badge, the narrowed week-follow rule.
6. **Hardening** — backoff, per-user cap, channel-status surfacing, the
   quickstart scenarios that need two replicas.

Stage 3 should be preceded by the `@Sse()`-on-Fastify spike (research #11).

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| `@Sse()` behaves poorly on the Fastify adapter (flush, disconnect detection) | Blocks stage 3 | Spike first; fallback is writing to `reply.raw` in one controller |
| An intermediary buffers the stream, so it works locally and not in production | Silent failure in prod only | Explicit `no-transform` / `X-Accel-Buffering` headers; quickstart scenario 5 runs against the real two-replica stack |
| ~~`apps/web` has no test runner~~ **Retired** — resolved by the Principle II decision above: `vitest` is added and the parser/backoff ship as tested pure functions | — | — |
| Path aliases (`@services/*`) may not resolve under vitest in `apps/web` | Test setup stalls on configuration rather than logic | Keep test imports relative; alias resolution is optional, not required |
| Replacing `workout-events.ts` touches every list at once | Broad blast radius | Keep the store's shape (`revision` + `useSyncExternalStore`) so call sites change minimally |
| Per-replica connection cap is not a global cap | A user could hold 2× the cap across replicas | Accepted — the goal is protecting a process from exhaustion, not exact accounting (research #10) |

## Complexity Tracking

No constitutional principle is violated, so nothing here requires a governance
justification. The table records the one place the feature exceeds its literal
brief, which is a scope judgement rather than a gate breach.

| Deviation | Why needed | Simpler alternative rejected because |
|---|---|---|
| Feature also repartitions where workouts are displayed (spec §"Where an unsettled workout lives", FR-009–FR-015) | Spec 003's FR-012 and this spec's FR-018 give contradictory answers when the parser rewrites a workout's date — a case that occurs whenever the user omits the date and the text contains one | Leaving the lists as they are forces a choice between silently removing a visible row and navigating the user off the week they are reading. Both were judged worse than moving unsettled workouts out of week-scoped views, which additionally fixes the pre-existing list/chart disagreement (SC-004) |

## Post-Design Constitution Re-check

Re-evaluated against v1.0.0 after Phase 1. Principles I, III, IV and V hold as
recorded above; the Phase 1 artifacts strengthened rather than weakened them —
the notification envelope ended up with a single definition used by both sides
(III), and `contracts/events.md` §3 makes the best-effort publishing rule
explicit at every producer rather than leaving it implied (IV).

Principle II now passes as well: the `apps/web` testing gate was closed by
adopting `vitest` there for pure logic (see the Constitution Check). **All five
principles pass.** No entry in Complexity Tracking is a governance violation.
