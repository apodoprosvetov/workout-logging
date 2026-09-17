# Implementation Plan: Web Shell & Weekly Dashboard

**Branch**: `003-web-shell-weekly-dashboard` | **Date**: 2026-09-08 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-web-shell-weekly-dashboard/spec.md`

## Summary

Turn `apps/web` from spec 001's single all-time dashboard page into a proper
signed-in application: persistent chrome (header + sidebar) around every
screen, logging reachable from anywhere through a modal, and a dashboard that
reviews **one training week at a time** rather than a lifetime total
(FR-001–FR-008). The week is fetched as a half-open `[after, before)` window
over `performed_at`, which `GET /workouts` supports via the `after` parameter
already added in the working tree.

Most of this is built. The plan's real work is the four gaps review found,
each now a requirement: a logged workout must appear in the list on screen
without a reload and pull the dashboard to its week (FR-011/FR-012, solved
with a small external store — research #1); pagination must stop dropping
rows that share a `performed_at` (FR-022, solved by making the ordering a
total order and moving to shared page/per_page pagination — research #2/#3);
the dead `tailwind.config.js` must go (FR-025 — research #6); and the
duplicated workout-row markup must collapse to one component (FR-024 —
research #8). Two structural corrections come with them: one root layout
instead of two, so signing in stops costing a full document load (research
#5), and a single import convention with no alias pointing at an empty
directory (FR-026 — research #7).

Scope discipline matters here. A workout is parsed asynchronously, so its
status changes after logging. Pushing *that* to an open screen needs a
server-to-client channel and shared client state — deferred to its own spec,
and written into this one as FR-013 so it is not mistaken for unfinished work.

## Technical Context

**Language/Version**: TypeScript 5 on Node.js 22, unchanged from spec 001.
No new language or runtime.

**Primary Dependencies**: `apps/web` — Next.js 16.3.1 (App Router, static
export), React 19.2.8, Tailwind CSS v4 via `@tailwindcss/postcss`. **No new
runtime dependency is added by this feature**; in particular no
data-fetching or state-management library (research #1 explains why that
choice belongs to the live-updates spec, not this one). `apps/api` — NestJS
on Fastify with TypeORM, unchanged.

**Storage**: Postgres via TypeORM, unchanged schema except one index
migration: `("user_id", "performed_at" DESC, "id" DESC)` replacing the
existing `("user_id", "performed_at")`, so the total ordering is satisfied by
the index scan rather than a sort on top (research #3). No new table, column,
or entity.

**Testing**: Vitest + Supertest contract tests in
`apps/api/tests/contract/workouts.list.spec.ts` for the new pagination envelope
and the total ordering — the standing rule that every changed `apps/api` route is
contract-tested. `apps/web` gets no test framework in this feature; it is
verified by `tsc --noEmit`, `eslint`, `next build`, and the manual scenarios
in [quickstart.md](./quickstart.md) (research #10, with the accepted risk
stated there).

**Target Platform**: Desktop browsers, current versions. `apps/web` ships as
a static export to S3 behind CloudFront (spec 002); `apps/api` runs on the
EC2 Docker Compose stack. No new infrastructure.

**Project Type**: Web application in an existing npm-workspaces monorepo —
static frontend plus HTTP API. `apps/web` talks to `apps/api` over HTTP only
and never touches a datastore directly (spec 001's plan.md).

**Performance Goals**: A week view issues exactly two requests (volume,
workouts) and must not re-request on unrelated re-renders. Pagination stays
cheap at this project's scale; correctness comes from the total ordering, not
from the cursor scheme (research #2).

**Constraints**: Static export — no server components doing data fetching, no
server actions, no middleware; every data read is a client fetch carrying a
Bearer token. Weeks are ISO weeks in UTC, matching `packages/shared`'s
`isoWeekKey`, because both dashboard panels must agree on the same week
(FR-004, research #9).

**Scale/Scope**: One user, one account, a few hundred workouts. Five routes
(`/`, `/login`, `/register`, `/dashboard`, `/workouts`).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**Status: no ratified constitution.** `.specify/memory/constitution.md` is
the unmodified spec-kit template — every principle is still a
`[PRINCIPLE_N_NAME]` placeholder. There are no ratified gates to evaluate
against, so this check cannot pass or fail on its own terms; recording that
honestly is better than inventing principles retroactively.

The project does have de facto rules, established across specs 001 and 002
and confirmed in this session. They are applied here as the working gates:

| De facto rule | Source | This feature |
| --- | --- | --- |
| Every new or changed `apps/api` route has contract tests | project rule, applied to `after` in the working tree | PASS — the envelope and ordering get contract tests (research #10) |
| `apps/web` speaks only HTTP to `apps/api`, never to a datastore | spec 001 plan.md | PASS — no change to that boundary |
| `apps/web` cannot import `@workout-logging/shared` (CommonJS barrel pulls in mongoose/pg/ioredis) | `lib/analytics.ts` | PASS — `isoWeekKey` stays mirrored client-side, as today |
| Contract changes are written into `contracts/api.md` | spec 001 | PASS — see [contracts/api-delta.md](./contracts/api-delta.md) |
| Prefer no new dependency until the need is proven | spec 002 research | PASS — research #1 defers the state manager with a stated reason |

**Post-Phase 1 re-check**: unchanged. The design adds no project, no service
boundary, and no runtime dependency; the single schema change is an index
swap. Complexity Tracking below is therefore empty.

## Project Structure

### Documentation (this feature)

```text
specs/003-web-shell-weekly-dashboard/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 output — 11 decisions
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output — validation scenarios
├── contracts/
│   ├── api-delta.md     # GET /workouts changes against spec 001's contracts/api.md
│   └── ui-routes.md     # Route map, chrome, and the client-side logged-workout signal
├── checklists/
│   └── requirements.md  # Spec quality checklist (18/18)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
apps/web/
├── app/
│   ├── layout.tsx              # CHANGED: the single root layout (html/body/fonts/metadata)
│   ├── globals.css             # CHANGED: body font uses --font-sans, not Arial
│   ├── (auth)/
│   │   ├── layout.tsx          # CHANGED: nested layout, chrome only, no <html>
│   │   ├── login/page.tsx
│   │   └── register/page.tsx
│   └── (main)/
│       ├── layout.tsx          # CHANGED: nested layout, header + sidebar only
│       ├── page.tsx            # "/" — routes to /dashboard or /login
│       ├── dashboard/page.tsx
│       └── workouts/page.tsx
├── components/
│   ├── header/
│   ├── sidebar/
│   ├── log-workout-button.tsx
│   ├── log-workout-form.tsx    # CHANGED: publishes on successful submit
│   └── workout-table.tsx       # NEW: the one workout-row definition (FR-024)
├── features/
│   ├── auth/
│   ├── dashboard/              # dashboard.tsx, volume-chart.tsx, weekly-workouts.tsx
│   └── workouts/               # workout-list.tsx, workout-detail.tsx
├── hooks/
│   └── use-require-auth.ts     # MOVED from services/ (FR-026)
├── services/                   # the only place that speaks HTTP
│   ├── api-client.ts           # transport: bearer token, 401 refresh-and-retry
│   ├── auth.ts                 # NEW: register / login / logout / hasSession
│   ├── analytics.ts            # NEW: getWeeklyVolume
│   ├── workouts.ts             # NEW: listWorkouts / getWorkout / deleteWorkout
│   └── workout-events.ts       # NEW: the logged-workout store (FR-011/FR-012)
├── lib/
│   ├── analytics.ts            # week math, mirrors packages/shared's isoWeekKey
│   ├── pagination.ts           # NEW: Paginated<T>, mirrors the API envelope
│   └── workouts.ts             # contract types, formatters, status labels
├── tailwind.config.js          # DELETED (FR-025)
└── tsconfig.json               # CHANGED: aliases, all resolving to real directories

apps/api/
├── src/workouts/
│   ├── dto/list-workouts-query.dto.ts   # CHANGED: extends PaginationQueryDto
│   └── workouts.service.ts              # CHANGED: total ordering + paginate()
├── src/common/pagination.dto.ts         # NEW: page / per_page base DTO
├── src/common/pagination.ts             # NEW: paginate() + Paginated<T>
└── tests/contract/workouts.list.spec.ts # CHANGED: envelope + ordering tests

packages/shared/
├── src/entities/workout.entity.ts       # CHANGED: @Index carries id
└── src/db/migrations/                   # NEW: index migration (research #3)
```

**Structure Decision**: The existing monorepo layout is kept as-is. Inside
`apps/web` the feature-folder split introduced in the working tree
(`features/` for screen-level composition, `components/` for shared UI,
`services/` for IO clients, `hooks/` for React hooks, `lib/` for pure
helpers and contract types) is adopted as the standing convention, with each
TypeScript path alias mapped to exactly one of those real directories —
which is what FR-026 asks for and what moving `use-require-auth.ts` into
`hooks/` completes.

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified.

No violations. The feature adds no project and no runtime dependency; the
only schema change is replacing one index with a wider version of itself.
