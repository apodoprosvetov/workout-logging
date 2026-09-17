# Feature Specification: Deployment & CI/CD

**Feature Branch**: `002-deployment-cicd`

**Created**: 2026-08-25

**Status**: Draft

**Input**: User description: "Deployment and CI/CD for the Workout Logging MVP: put the existing (currently git-less) monorepo under git and push it to GitHub, deploy the multi-service stack (apps/api, apps/worker, apps/web, plus Postgres/MongoDB/Redis/RabbitMQ) somewhere reachable over public HTTPS, and set up CI/CD so pushes are tested and deployed automatically. Note: apps/api's POST /telegram/webhook route (T038-T041, not yet built) will need a real public HTTPS URL from Telegram, which is a concrete driver for this work beyond 'just for show'."

## Clarifications

### Session 2026-09-04

- Note: The Telegram bot (spec 001, User Story 2 / T038–T041) that
  originally motivated User Story 3 and FR-006 was **descoped** on
  2026-09-04. User Story 3 stays in scope unchanged — a stable public
  HTTPS endpoint that accepts direct (non-browser) inbound requests is
  still wanted for a future conversational MCP server / webhook consumer,
  which has the same shape. "Telegram" below reads as "an external
  service"; it was already delivered and verified (T029).

### Session 2026-08-25

- Q: Where should the application be deployed? → A: AWS, on a single EC2
  instance running the existing Docker Compose stack directly — not
  ECS/Fargate. The stateful services (Postgres, MongoDB, Redis, RabbitMQ)
  don't fit Fargate's stateless-container model without also adding
  RDS/ElastiCache/DocumentDB/Amazon MQ plus an ALB and VPC networking —
  disproportionate cost and operational complexity for this project's
  scale (personal/learning project, no requirement for independently
  scaling services).
- Q: If the EC2 instance is lost or its data is corrupted, how much data
  loss is acceptable before automated backups must have captured it? → A:
  Weekly backups — up to 7 days of data could be lost on instance failure,
  minimizing backup cost/complexity for this project's scale.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Automated testing on every push (Priority: P1)

As the maintainer, when code is pushed for review, the full automated test
suite runs without any manual step, and the result (pass/fail) is visible
before that code can reach production.

**Why this priority**: This is the foundation everything else depends on —
it delivers real standalone value (catching regressions automatically)
even before any deployment automation exists, and every later story
assumes it's already in place as a gate.

**Independent Test**: Push a change that breaks an existing test; confirm
the failure is reported automatically and nothing downstream (deploy)
proceeds. Push a change that passes; confirm success is reported.

**Acceptance Scenarios**:

1. **Given** a code change is pushed for review, **When** the change is
   received, **Then** the full automated test suite runs against it
   automatically, with no manual trigger required.
2. **Given** the test suite fails on a pushed change, **When** the
   maintainer looks at the change, **Then** the failure is clearly visible
   and that change is blocked from being deployed.
3. **Given** the test suite passes on a pushed change, **When** the
   maintainer looks at the change, **Then** success is clearly visible.

---

### User Story 2 - Automatic deployment to a live, public environment (Priority: P2)

As the maintainer, when a change is approved and merged, it becomes live
and reachable over the public internet (HTTPS) automatically, without a
manual deployment step.

**Why this priority**: This is the core value of the whole feature — an
app only tested locally isn't usable by anyone, including the maintainer
away from their dev machine. Depends on User Story 1 being in place as a
safety gate.

**Independent Test**: Merge an approved change and, without performing any
manual deploy action, confirm the running public application reflects
that change within a bounded time window.

**Acceptance Scenarios**:

1. **Given** a change has passed all automated tests and is merged,
   **When** the merge completes, **Then** the application is redeployed
   automatically with no manual step.
2. **Given** the application has been deployed, **When** anyone visits its
   public URL, **Then** they reach it over a secure (HTTPS) connection.
3. **Given** a deploy is in progress, **When** a user is using the
   currently-live version, **Then** they are not disrupted (no downtime
   window with an unreachable app).
4. **Given** a deploy involves a database schema change, **When** the
   deploy runs, **Then** existing data is preserved — a deploy never
   causes data loss.

---

### User Story 3 - Public endpoint reachable by an external service (Priority: P3)

As the maintainer, the deployed application exposes a stable public HTTPS
endpoint that a third-party service can call directly, not just a URL that
a human can browse to.

> Originally motivated by the planned Telegram bot (spec 001, US2),
> **descoped 2026-09-04**. The capability is still wanted — a future
> conversational MCP server / webhook consumer needs the exact same
> thing. This story was already delivered and verified (T029).

**Why this priority**: Enables any external-service integration (the
planned Telegram bot, later a conversational MCP server) to work at all
once built — without this, such a feature is permanently blocked
regardless of how well it's implemented. Lower priority than Stories 1–2
because it's a specific consequence of "the app is live," not a separate
deployment mechanism.

**Independent Test**: From outside the deployment environment, send a
direct HTTP request (not through a browser) to the application's
webhook-style endpoint and confirm it responds successfully, the same way
an external service would reach it.

**Acceptance Scenarios**:

1. **Given** the application is deployed, **When** an external system
   sends a direct HTTPS request to its public webhook endpoint, **Then**
   the request reaches the application and receives a response.
2. **Given** the deployment environment, **When** its public HTTPS
   endpoint is inspected, **Then** it presents a valid, trusted TLS
   certificate (no manual trust exception needed).

---

### User Story 4 - Recovering from a bad deploy (Priority: P4)

As the maintainer, if a deployed change causes a problem, the previous
working version can be restored quickly, without writing new code first.

**Why this priority**: A safety net, not core deployment value — but
without it, every deploy going forward carries higher risk, which
undermines the confidence Stories 1–2 are meant to provide.

**Independent Test**: Deploy a version, then trigger a rollback to the
prior version, and confirm the previous version is live again within a
bounded time window.

**Acceptance Scenarios**:

1. **Given** a deployed version is causing a problem, **When** the
   maintainer initiates a rollback, **Then** the previous working version
   becomes live again without requiring a new code change first.
2. **Given** a rollback has completed, **When** the application is
   checked, **Then** it behaves exactly as the previous working version
   did.

---

### User Story 5 - Proactive alerting on problems (Priority: P5)

As the maintainer, when the application or a deploy has a problem, I'm
notified automatically (e.g. by email) without needing to actively check
dashboards or logs myself.

**Why this priority**: Builds on the reactive safety nets already
established (Stories 1–4) by surfacing problems proactively instead of
only when someone happens to look. Valuable but not blocking — the
application is already fully usable without it.

**Independent Test**: Deliberately trigger a failure condition (a failed
deploy, or the running application becoming unreachable) and confirm a
notification arrives without any manual polling or log-checking.

**Acceptance Scenarios**:

1. **Given** a deploy fails, **When** the failure occurs, **Then** the
   maintainer receives a notification without having to check anything
   manually.
2. **Given** the running application becomes unhealthy or unreachable,
   **When** that happens, **Then** the maintainer is notified within a
   bounded time window.
3. **Given** the application is healthy and operating normally, **When**
   routine operation continues, **Then** no alert is sent (no false
   positives).

---

### Edge Cases

- What happens when a deploy fails partway through (e.g. one of the
  application's services fails to start)? The previous working version
  MUST remain live; the system MUST NOT end up serving a partially-updated
  or broken version.
- What happens when a database migration included in a deploy fails? The
  deploy MUST stop before the application starts serving traffic on the
  new version, and existing data MUST remain intact and accessible to the
  still-running previous version.
- What happens to work in progress (asynchronous background processing)
  when a deploy restarts a running service? It MUST NOT be silently lost —
  it must either complete first, or be safely retried after restart.
- What happens if a secret (credential, API key) needs to change? It MUST
  be updatable without any change to version-controlled source code.
- What happens if the automated test run itself cannot complete (e.g. the
  testing service is unavailable)? The system MUST fail safe — treat this
  the same as a test failure, not silently allow the deploy to proceed.
- What happens if the alerting channel itself is unavailable (e.g. email
  delivery fails)? The problem MUST still be discoverable through at least
  one other means (e.g. visible status in the CI/deployment platform) —
  alert delivery failing MUST NOT mean the problem goes completely unseen.
- What happens if a problem is ongoing (e.g. the application stays
  unreachable for an extended period)? The maintainer MUST NOT be sent
  repeated duplicate alerts for the same unresolved problem.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The application's source code MUST be tracked in version
  control, with a complete history of changes.
- **FR-002**: The system MUST automatically run the full automated test
  suite whenever a code change is pushed for review, with no manual step
  required to trigger it.
- **FR-003**: The system MUST prevent a code change from being deployed to
  production if the automated test suite fails against it.
- **FR-004**: The system MUST automatically deploy an approved, merged
  change to production with no manual deployment step.
- **FR-005**: The deployed application MUST be reachable from the public
  internet over a secure (HTTPS), trusted connection.
- **FR-006**: The deployed application MUST expose at least one public
  endpoint capable of receiving direct inbound requests from a third-party
  service (not only browser-driven traffic), to support external-service
  integrations (originally the planned Telegram bot, descoped 2026-09-04;
  a future conversational MCP server has the same need).
- **FR-007**: The system MUST allow the maintainer to revert production to
  the previous working version without writing or merging new code.
- **FR-008**: The system MUST NOT expose secrets (credentials, API keys,
  connection strings) in version-controlled source code or in
  publicly-readable build/deploy output — consistent with the existing
  requirement that secrets never live in the codebase (spec 001, FR-019).
- **FR-009**: A deploy MUST NOT cause loss of previously stored data.
- **FR-010**: The system MUST make deploy failures and post-deploy health
  problems visible to the maintainer without requiring them to actively go
  looking for them.
- **FR-011**: The system MUST keep the previous working version serving
  traffic until the new version has been confirmed healthy, rather than
  taking the application offline during the switch.
- **FR-012**: The system MUST notify the maintainer through an
  out-of-band channel (e.g. email) when a deploy fails.
- **FR-013**: The system MUST continuously monitor the health of the
  running application after deploy and notify the maintainer if it
  becomes unhealthy or unreachable.
- **FR-014**: The system MUST NOT send repeated duplicate alerts for the
  same ongoing, already-reported problem.
- **FR-015**: The system MUST back up all persisted data at least weekly,
  in a way that a restore is actually possible if the running environment
  is lost.

### Key Entities

- **Deployment**: A specific, versioned release of the application that
  was made live at a point in time; has a status (e.g. in progress, live,
  failed, rolled back) and is tied to the exact code change it came from.
- **Pipeline Run**: One execution of the automated test-and-deploy process
  triggered by a code change; has a pass/fail outcome and, if it passed
  and reached deployment, is linked to the Deployment it produced.
- **Environment**: The live target the application runs in (this feature
  assumes a single production environment; see Assumptions).
- **Alert**: A notification sent to the maintainer when a monitored
  condition (deploy failure, application health check failure) is
  detected; has a trigger condition, a delivery channel, and a timestamp,
  and is suppressed while an equivalent alert is already outstanding
  (FR-014).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After a code change is pushed, its automated test result
  (pass/fail) is visible within 10 minutes with no manual action taken.
- **SC-002**: After a change is merged, it is live at the public URL
  within 15 minutes, with no manual deployment step performed.
- **SC-003**: The deployed application is reachable over HTTPS at least
  99% of the time in a given month, excluding announced maintenance.
- **SC-004**: The maintainer can restore the previous working version in
  under 10 minutes without writing new code.
- **SC-005**: A full scan of the version-control history finds zero
  exposed secret values.
- **SC-006**: An external service can successfully deliver a request to
  the application's public webhook endpoint on the first attempt, without
  retries caused by the deployment environment itself (e.g. certificate
  errors, connection refusal).
- **SC-007**: When a deploy fails or the running application becomes
  unreachable, the maintainer receives a notification within 10 minutes
  without manually checking anything.
- **SC-008**: If the running environment is lost entirely, at most 7
  days of data is unrecoverable, restored from the most recent backup.

## Assumptions

- A single production environment is in scope for this feature; a
  separate staging/pre-production environment is deferred beyond this
  spec.
- GitHub is the version-control host, consistent with this project's
  existing tooling (issue-tracking integration already assumes GitHub).
- Database/schema migrations run as an automatic part of each deploy,
  consistent with the migration approach already established in spec 001.
- No custom domain name is required for this feature — a
  platform-provided or otherwise stable HTTPS URL is sufficient; a custom
  domain can be layered on later without requiring spec changes.
- This feature deploys the application's three processes (apps/api,
  apps/worker, apps/web) and their four backing data stores (Postgres,
  MongoDB, Redis, RabbitMQ) as a single coordinated release on a single
  host, not as independently versioned/orchestrated services (see
  Clarifications — AWS EC2 + Docker Compose, not ECS/Fargate).
- Monitoring/alerting for this feature covers deploy status and basic
  application health (reachability) with email notification (FR-012–014,
  SC-007). Deeper observability (distributed tracing, custom business
  metrics/dashboards) is a nice-to-have the maintainer is open to
  exploring during planning, but it isn't a stated requirement here.
- Cost is a real constraint (personal/learning-scale project, not a
  funded product) and should favor low, predictable spend over
  enterprise-grade scalability headroom.
