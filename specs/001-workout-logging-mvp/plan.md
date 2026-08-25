# Implementation Plan: Workout Logging MVP

**Branch**: `001-workout-logging-mvp` | **Date**: 2026-08-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-workout-logging-mvp/spec.md`, with
architecture decisions carried over from [design-notes.md](./design-notes.md)

## Summary

Let a person log a workout as free text and/or a photo, in a single
submission — a Telegram photo message with a caption is both at once
(research.md #8) — from the web app or Telegram, and have it parsed by
Claude into structured exercises/sets so
weekly volume per muscle group is visible on a dashboard. Ingestion is
synchronous-and-fast (ack < 2s); parsing and analytics update happen
asynchronously via RabbitMQ. Built as a Node.js/TypeScript monorepo: a
Next.js web app, a NestJS (Fastify-adapter) API service (also hosting
the Telegram webhook), and a worker process consuming RabbitMQ events —
sharing Postgres (normalized data), MongoDB (raw uploads + exercise
catalog), and Redis (rate limiting + cached weekly aggregates).

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 LTS (user-selected)

**Primary Dependencies**: NestJS (`@nestjs/core`, `@nestjs/common`)
on the Fastify HTTP adapter (`@nestjs/platform-fastify`) for `apps/api`
(research.md #1); Next.js 14+ (web dashboard) with Tailwind CSS v4
(`@tailwindcss/postcss`) for styling; `node-telegram-bot-api`
or raw Telegram Bot API via webhook; `amqplib` (RabbitMQ); TypeORM
(Postgres entities) and Mongoose (MongoDB schemas) — defined once in
`packages/shared` and consumed by both `apps/api` (via `@nestjs/typeorm`
/ `@nestjs/mongoose`) and `apps/worker` (via a standalone `DataSource` /
`mongoose.connect()`, no Nest); `ioredis`; `@anthropic-ai/sdk` (Claude);
`class-validator` + `class-transformer` (request validation, DTOs, api
only); `jsonwebtoken` + `argon2` (auth). `apps/worker` stays plain
Node.js/TypeScript (no Nest, no HTTP surface) — it shares the TypeORM/
Mongoose model layer with `apps/api` but not the web framework.

**Storage**: PostgreSQL (users, workouts, workout_exercises, sets,
exercises — normalized, relational; modeled as TypeORM entities in
`packages/shared`, shared by `apps/api` and `apps/worker`); MongoDB
(raw_uploads, exercise catalog with aliases/muscle groups/equipment;
modeled as Mongoose schemas in `packages/shared`, likewise shared);
Redis (per-user rate limit counters, cached weekly volume aggregates —
raw `ioredis` client, no ORM)

**Testing**: Vitest for unit/integration tests; Supertest for HTTP
contract tests against the API; integration tests run against real
Postgres/MongoDB/Redis/RabbitMQ via Docker Compose (no mocking the
databases or broker)

**Target Platform**: Linux containers (Docker Compose for local/dev;
each of web/api/worker is an independently deployable Node process)

**Project Type**: Web application (frontend + backend + background
workers)

**Performance Goals**: Ingestion endpoints acknowledge in < 2s (SC-002);
weekly volume reflects a parsed workout within a few seconds (SC-007);
supports the personal/low-concurrency scale described below without
special tuning

**Constraints**: JWT access token short-lived (15 min) + rotating
refresh token; ingestion rate-limited to 30 requests/minute/user
(FR-018, via Redis); linking codes limited to 5 attempts/hour/account
(FR-005); secrets via environment variables only (FR-019); event
processing must be idempotent on `event_id` (FR-014)

**Scale/Scope**: Single real user in practice, but every table/query
scoped by `user_id` so a second account requires no schema change;
low request volume (personal-scale, not high-throughput)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is still the unfilled template (no
project-specific principles have been ratified yet) — there are no
gates to evaluate against. This is not blocking for a solo MVP; run
`/speckit-constitution` before this becomes a multi-contributor project
so future plans have real principles (testing discipline, simplicity,
etc.) to check against.

**Result**: PASS (no constitution defined — nothing to violate)

**Post-Phase 1 re-check**: data-model.md, contracts/, and quickstart.md
introduce no new external dependencies or architectural deviations
beyond what's in Technical Context above — PASS, unchanged.

## Project Structure

### Documentation (this feature)

```text
specs/001-workout-logging-mvp/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   ├── api.md
│   └── events.md
├── design-notes.md      # Pre-existing architecture draft (input, not generated)
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
apps/
├── web/                       # Next.js dashboard (SPA-ish, App Router)
│   ├── app/
│   │   ├── (auth)/login/
│   │   ├── (auth)/register/
│   │   ├── dashboard/
│   │   └── workouts/[id]/
│   └── tests/
│
├── api/                       # NestJS (Fastify adapter) HTTP API + Telegram webhook
│   ├── src/
│   │   ├── main.ts             # Nest bootstrap (FastifyAdapter)
│   │   ├── app.module.ts
│   │   ├── auth/                # AuthModule: controller, service, DTOs, guard, entities
│   │   ├── telegram/            # TelegramModule: controller, bot-sender service
│   │   ├── workouts/            # WorkoutsModule: controller, ingestion service, entities
│   │   ├── analytics/           # AnalyticsModule: controller
│   │   └── events/              # RabbitMQ publisher (Nest provider)
│   └── tests/
│       ├── contract/
│       └── integration/
│
└── worker/                    # RabbitMQ consumers (plain Node, no Nest)
    ├── src/
    │   ├── parser/             # Claude call, exercise/muscle-group mapping (via shared TypeORM/Mongoose models)
    │   ├── analytics/          # weekly volume aggregation → Redis (via shared TypeORM models)
    │   └── events/             # RabbitMQ consumer setup, retry/DLQ wiring
    └── tests/
        └── integration/

packages/
└── shared/                    # Shared TypeScript types + model layer
    └── src/
        ├── events/             # event payload types (must match exactly between publisher/consumers)
        ├── entities/           # TypeORM entities (User, Workout, WorkoutExercise, Set, Exercise, ...)
        ├── schemas/            # Mongoose schemas (RawUpload, ExerciseCatalog)
        └── db/                 # TypeORM DataSource factory, Mongoose connection factory,
                                 # TypeORM migrations, Redis client factory, idempotency helper

docker-compose.yml              # Postgres, MongoDB, Redis, RabbitMQ, apps
```

**Structure Decision**: Web application layout, split into three
independently runnable Node processes (`apps/web`, `apps/api`,
`apps/worker`) plus a `packages/shared` library for both the event
payload types (must match exactly between the API publisher and worker
consumers) and the TypeORM/Mongoose model layer, so `apps/api` and
`apps/worker` share one canonical set of entities/schemas instead of
maintaining two (research.md #1, "Data-layer uniformity"). `apps/web`
never talks to Postgres/Mongo/Redis/RabbitMQ directly — it only calls
`apps/api` over HTTP, so all user-data scoping (FR-015) is enforced in
one place.

## Complexity Tracking

*No constitution violations to justify — section intentionally empty.*
