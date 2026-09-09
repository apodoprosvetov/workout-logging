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

`.specify/memory/constitution.md` is **an unfilled template** — every principle
is still a `[PRINCIPLE_N_NAME]` placeholder. There are no ratified gates to
evaluate, so this check cannot pass or fail on project-defined criteria.

Applied instead, as the closest thing to standing rules in this project:

| Rule | Source | Status |
|---|---|---|
| Contract-test every new `apps/api` route | standing instruction | Planned — enumerated in [contracts/api.md](./contracts/api.md) |
| `apps/web` never talks to datastores directly | spec 001 plan, restated in `api-client.ts` | Held — the client only consumes `/api/events` and REST |
| One definition of a wire payload | existing `packages/shared/src/events/types.ts` | Held — notification shape lives in shared, used by producer and consumer |
| Publish only after the state commits | `apps/worker/src/parser/handler.ts:48` | Held — see [contracts/events.md](./contracts/events.md) |

**Recommendation**: the constitution is worth filling in via
`/speckit-constitution` — four specs have now been planned without one. Not a
blocker for this feature.

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
│   └── event-stream.ts        # NEW — fetch-based SSE reader, parser, backoff
├── features/
│   ├── in-flight/             # NEW — modal, list, dismiss, count badge
│   ├── dashboard/             # settled-only filter; week-follow rule
│   └── workouts/              # settled-only filter
└── components/
    └── log-workout-button.tsx # + in-flight count, opens the modal
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
| `apps/web` has no test runner, so the frame parser and backoff ship untested | Regressions land unnoticed in the trickiest code | Decide during `/speckit-tasks`: add vitest to `apps/web`, or accept manual coverage and keep the logic in small pure functions |
| Replacing `workout-events.ts` touches every list at once | Broad blast radius | Keep the store's shape (`revision` + `useSyncExternalStore`) so call sites change minimally |
| Per-replica connection cap is not a global cap | A user could hold 2× the cap across replicas | Accepted — the goal is protecting a process from exhaustion, not exact accounting (research #10) |

## Complexity Tracking

No constitution gates exist to violate, so this table records the one place the
feature exceeds its literal brief instead.

| Deviation | Why needed | Simpler alternative rejected because |
|---|---|---|
| Feature also repartitions where workouts are displayed (spec §"Where an unsettled workout lives", FR-009–FR-015) | Spec 003's FR-012 and this spec's FR-018 give contradictory answers when the parser rewrites a workout's date — a case that occurs whenever the user omits the date and the text contains one | Leaving the lists as they are forces a choice between silently removing a visible row and navigating the user off the week they are reading. Both were judged worse than moving unsettled workouts out of week-scoped views, which additionally fixes the pre-existing list/chart disagreement (SC-004) |

## Post-Design Constitution Re-check

Unchanged from the pre-Phase-0 check: no ratified gates exist. The four standing
rules above still hold after design — in particular, the notification payload
has exactly one definition (`packages/shared`), and no new datastore was
introduced, satisfying the spec's own deployment-reality assumption.
