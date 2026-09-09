<!--
SYNC IMPACT REPORT
==================
Version change: (unversioned template) → 1.0.0

This is the first ratified constitution. The file previously contained only
unfilled scaffold placeholders ([PRINCIPLE_1_NAME] etc.), so four features
(001, 002, 003, 004) were specified and planned with no gates to check against.
Every principle below is derived from practice already visible in the repository
and its specs, not newly invented — this codifies what the project does, so it
can be enforced rather than rediscovered.

Modified principles: none (no prior principles existed)

Added sections:
  - Core Principles I–V
  - Operational Constraints
  - Development Workflow & Quality Gates
  - Governance

Removed sections: none

Evidence base for each principle is cited inline so a reviewer can verify the
rule reflects reality rather than aspiration.

Follow-up TODOs: none. RATIFICATION_DATE is today because this is the first
adoption; the repository's first commit (2026-08-25) predates it, and no earlier
governance document exists to inherit a date from.
-->

# Workout Logging Constitution

## Core Principles

### I. Spec-Driven Change

Every non-trivial change begins as a specification under `specs/<NNN>-<slug>/`
and proceeds through plan and tasks before implementation. Specifications state
WHAT and WHY in user-observable terms; HOW belongs in `plan.md`, `research.md`,
and `contracts/`.

- A specification MUST NOT name a framework, library, or transport. If a
  requirement cannot be stated without one, it is a design decision and belongs
  in `research.md`.
- Every design decision recorded in `research.md` MUST state the alternatives
  considered and why they lost. A decision with no rejected alternative is
  either obvious or unexamined, and the entry must say which.
- When a decision has several viable options with materially different
  consequences, it MUST be put to the maintainer before being made, not
  reported afterwards as settled.
- A plan that contradicts its own specification is a defect. If design work
  invalidates the spec, amend the spec and record why in its checklist — do not
  let the two drift.

**Rationale**: Four features were built this way before this document existed,
and the specs are the only durable record of *why* the system is shaped as it
is. Spec 003's research notes correctly predicted and scoped spec 004's work;
that only pays off if the practice is consistent.

### II. Verified Against Real Infrastructure

Correctness claims MUST rest on evidence produced by running the thing, not on
inspection or assertion.

- Tests run against real Postgres, MongoDB, Redis, and RabbitMQ containers.
  Mocking a datastore to make a test pass is prohibited; if a test is hard to
  write against the real thing, that difficulty is information about the design.
- Every route exposed by `apps/api` MUST have a contract test under
  `apps/api/tests/contract/`, added in the same change that adds the route.
- Work is reported complete only after its observable behaviour has been
  checked — a passing suite, a real request, a real log line. "Implemented" is
  not "verified", and the two MUST NOT be conflated in status reports.
- When a test fails or a step is skipped, that MUST be stated plainly along with
  the output, never summarised away.

**Rationale**: `apps/api/tests/contract/` already holds one spec file per route,
and `README.md` states the suites run against real containers. This principle
also protects against the failure mode this project has actually hit: a rollout
gap in `infra/Caddyfile` that only appeared under a live restart test, and a
RabbitMQ retry behaviour that was only understood by observing the live broker.

### III. One Definition, Enforced Boundaries

A contract has exactly one definition, and each layer stays inside its boundary.

- Entities, schemas, migrations, event types, and wire payloads shared by more
  than one app MUST live in `packages/shared` and be imported, never restated.
- `apps/web` MUST NOT talk to Postgres, MongoDB, Redis, or RabbitMQ. It knows
  the HTTP contract and nothing else.
- `apps/worker` MUST NOT expose an HTTP surface.
- A payload documented in a `contracts/` file and the type that implements it
  MUST agree; when they diverge, the contract file is the specification and the
  code is the defect.

**Rationale**: Already load-bearing — `packages/shared/src/events/types.ts` is
the single definition both the publisher in `apps/api` and the consumer in
`apps/worker` compile against, which is what makes cross-process event changes
safe. `apps/web/services/api-client.ts` documents its own boundary in the same
terms.

### IV. Events Are Durable; Notifications Are Not

Background work and user-facing notification are different concerns with
different guarantees, and MUST NOT share machinery.

- An event that drives work MUST be published only after the state it describes
  has committed. Announcing a state that can still roll back is a defect, not a
  race to be tolerated.
- Every consumer of a durable event MUST be idempotent. Redelivery is normal.
- Failed work MUST walk the established retry tiers and then reach a dead-letter
  queue or an explicitly reasoned drop — never an unbounded retry, never a
  silent discard.
- A consumer MUST NOT infer message identity from the routing key when the
  message can be redelivered through a retry tier; the body is the only part
  that survives every hop unchanged.
- Failure to deliver a user-facing notification MUST NOT fail, roll back, or
  block the underlying change.

**Rationale**: Every clause here was learned the hard way and is documented in
the code: `withEventIdempotency` in `packages/shared/src/db/idempotency.ts`, the
retry tiers in `packages/shared/src/events/rabbitmq.ts`, and the extended
comment in `apps/worker/src/analytics/handler.ts` explaining that a redelivered
deletion arrives claiming to be a parse — a bug that would have caused silent,
permanent staleness.

### V. The Code Records Why

Comments explain reasoning that the code cannot express, not what the code
already says.

- A non-obvious decision, a workaround, or a constraint imposed by an external
  system MUST be commented with its reason.
- A comment asserting how an external system behaves MUST say how that was
  established — observed against the live broker, measured in a rollout test,
  read from a specific configuration default.
- Comments referencing a spec requirement SHOULD cite it (`FR-016`,
  `research.md #3`) so the requirement and its implementation stay findable from
  each other.
- A comment that has become false MUST be corrected or removed in the change
  that falsifies it.

**Rationale**: This codebase's comments are unusually load-bearing — they carry
findings that would otherwise have to be rediscovered by reproducing an outage.
The `lb_try_duration` note in `infra/Caddyfile` records ten real 502s and why the
default was wrong; without it, a future reader would plausibly delete the line.

## Operational Constraints

These are properties of the running system that changes MUST respect.

- **Two API replicas.** `api-1` and `api-2` sit behind Caddy round-robin. No
  design may assume a request, a connection, or in-memory state belongs to a
  particular replica, or that one replica can observe another's memory.
- **Rolling deploys.** Replicas restart one at a time, so two versions run
  concurrently during a deploy. Schema and contract changes MUST be compatible
  across adjacent versions.
- **The web app is a static export.** `apps/web` has no server runtime. Nothing
  may depend on server-side rendering, server actions, or Next.js middleware.
- **The CDN is part of the contract.** CloudFront fronts `/api/*` with its own
  defaults — notably a 30-second origin read timeout, unset in
  `infra/terraform/cloudfront.tf`. Behaviour that depends on a CDN default MUST
  name that default where it is relied upon.
- **Secrets never touch disk in production.** Runtime secrets live in AWS
  Systems Manager Parameter Store as `SecureString` and are resolved into the
  environment at deploy time. No secret may be committed, written to a file on
  the instance, or logged.
- **Structured logs only.** `apps/api` and `apps/worker` emit one JSON object per
  line. New log output MUST go through the existing structured loggers, never
  bare `console.log`.
- **Cost is a constraint.** This runs on one `t3.small` for a small user base.
  A change that adds a paid AWS component, or a new datastore, MUST justify it
  explicitly — monitoring was already switched off for costing ~$10/month.

## Development Workflow & Quality Gates

**The cycle**: `/speckit-specify` → `/speckit-plan` → `/speckit-tasks` →
`/speckit-implement`, with the specification amended in place whenever later
work invalidates it.

**Before implementation begins**:

- The specification has no unresolved `[NEEDS CLARIFICATION]` markers.
- Its quality checklist passes, and any amendment is recorded there with its
  reason.
- The plan states its risks and names the ones it is accepting rather than
  mitigating.

**Within a change**:

- New `apps/api` routes ship with contract tests (Principle II).
- Migrations live in `packages/shared/src/db/migrations/` and are additive
  wherever a rolling deploy could otherwise break (Operational Constraints).
- `npm run lint` and `npm run format:check` pass.

**Before merge to `main`**:

- The full suite passes in CI. `deploy.yml` runs `ci.yml` first and skips the
  deploy on failure — a red suite MUST NOT be worked around, disabled, or
  marked skipped to unblock a release.

**Known gap, accepted deliberately**: `apps/web` has no test runner configured,
so client-side logic is covered only by manual scenarios in each feature's
`quickstart.md`. Any feature placing non-trivial logic in `apps/web` MUST decide
explicitly whether to close this gap or accept it, and record that decision.

## Governance

This constitution takes precedence over habit, convenience, and prior local
practice. Where it conflicts with an existing pattern in the code, the code is
what changes — or this document is amended to say why the pattern stands.

**Amendment procedure**: Amendments are made through `/speckit-constitution`,
which MUST record a Sync Impact Report at the top of this file describing the
version change and every section added, modified, or removed. An amendment that
adds or tightens a rule MUST cite the evidence or incident that motivated it.

**Versioning policy** (semantic):

- **MAJOR** — a principle is removed or redefined in a way that invalidates
  existing compliant work.
- **MINOR** — a principle or section is added, or its guidance materially
  expanded.
- **PATCH** — clarification, wording, or citation fixes that change no
  obligation.

**Compliance review**: `/speckit-plan` MUST evaluate its feature against these
principles in its Constitution Check and record the result. A violation is
permitted only when recorded in that plan's Complexity Tracking table with the
simpler alternative that was rejected and why. An unjustified violation blocks
the plan.

**When a principle proves wrong**: amend it. A rule that is routinely bypassed
in practice is worse than no rule, because it teaches that this document can be
ignored. Bring the evidence and change the text.

**Version**: 1.0.0 | **Ratified**: 2026-09-09 | **Last Amended**: 2026-09-09
