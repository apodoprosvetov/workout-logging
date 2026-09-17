# Implementation Plan: Deployment & CI/CD

**Branch**: `002-deployment-cicd` | **Date**: 2026-08-25 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-deployment-cicd/spec.md`

## Summary

Put the existing spec-001 monorepo under version control (GitHub) and stand
up a fully automated test-and-deploy pipeline: every push runs the existing
Vitest/Supertest suites (FR-002/003); an approved merge to `main` builds
`apps/api`/`apps/worker` as Docker images (pushed to ECR) and `apps/web` as
a Next.js static export (uploaded to S3) — `apps/web` has no
server-rendering/API-routes/server-actions, so it doesn't need to run as a
container at all. A single CloudFront distribution fronts both: `/` routes
to S3, API paths route to a single AWS EC2 instance running
`apps/api`/`apps/worker` plus Postgres/MongoDB/Redis/RabbitMQ via Docker
Compose behind Caddy (FR-004/005/006/011) — all reachable at CloudFront's
own free default domain, no custom domain or certificate needed. Because
web and api share that one CloudFront domain, they're same-origin in
production — no CORS needed — and the EC2 instance's security group only
accepts traffic from CloudFront, never the public internet directly.
Rollback is redeploying the previous
build (image tag or S3 build prefix) through the same pipeline (FR-007). A
CloudWatch Synthetics canary plus SNS email covers deploy-failure and
post-deploy health alerting (FR-010/012/013/014); AWS Backup takes weekly
EBS snapshots for disaster recovery (FR-015/SC-008). No new application
code beyond one route-shape change in `apps/web` — this is entirely CI/CD
pipeline configuration and infrastructure-as-code.

## Technical Context

**Language/Version**: No new application language. Infrastructure/CI
configuration only: Terraform (HCL) for AWS resources, YAML for GitHub
Actions workflows, shell for the deploy/health-check glue — the existing
TypeScript/Node.js application (spec 001) is unchanged, aside from one
routing change noted below.

**Primary Dependencies**: GitHub Actions (CI/CD pipeline); Terraform (AWS
infrastructure as code, research.md #5); Amazon ECR for `apps/api`/
`apps/worker` images only (research.md #1); an S3 bucket for `apps/web`'s
static export (research.md #1); a single CloudFront distribution fronting
both, reachable at its own default `*.cloudfront.net` domain — no ACM
certificate, no custom domain (research.md #3–4); AWS Systems Manager
(SSM) Run Command to trigger the EC2 rollout without an open SSH port
(research.md #2); Caddy (plain-HTTP origin-side reverse proxy / load
balancer across `apps/api`'s replicas — no TLS, research.md #3) in front
of the Docker Compose stack; Amazon CloudWatch Synthetics (canary) +
Amazon SNS (email) for alerting (research.md #8); AWS Backup (scheduled
EBS snapshots, research.md #9).

**Storage**: Same Postgres/MongoDB/Redis/RabbitMQ as spec 001, unchanged
schema/data model — this feature only changes *where* they run: as Docker
Compose containers on a single EC2 instance's EBS volume. That EBS volume
is the actual persistence medium backed up for FR-015/SC-008. `apps/web`'s
built static assets live in S3 (reproducible from source at any time, no
backup needed — research.md #9).

**Testing**: Reuses spec 001's existing Vitest/Supertest suites unchanged
— CI's job is to run them automatically (FR-002/003), not add new test
types. New: a post-deploy HTTP smoke test against the live CloudFront URL,
gating FR-011's "confirm healthy before switching."

**Target Platform**: AWS — CloudFront (global edge, its own default
domain) in front of an S3 bucket (`apps/web`) and a single EC2 Linux
instance running Docker Compose (`apps/api`/`apps/worker` + data stores),
region `eu-central-1` as a reasonable default for the EC2/EBS/ECR
resources (CloudFront itself is a global service, not region-pinned).

**Project Type**: Infrastructure / deployment automation for the existing
spec-001 application. One code change to existing application source:
`apps/web`'s `/workouts/[id]` route becomes `/workouts?id=` to work under
static export (research.md #1) — otherwise no new application-layer code.

**Performance Goals**: SC-001 (test result visible <10 min), SC-002 (live
<15 min post-merge), SC-003 (≥99% monthly HTTPS reachability), SC-004
(rollback <10 min), SC-007 (alert <10 min), SC-008 (≤7 days of data
unrecoverable in a total-loss scenario).

**Constraints**: Cost-conscious — a single small EC2 instance, no
ALB/NAT Gateway/managed-DB/ACM/Route53 services (spec Clarifications: EC2
over ECS/Fargate; research.md #3: no custom domain needed either);
secrets only via GitHub Actions encrypted secrets + AWS Systems Manager
Parameter Store, never in git (FR-008); zero-downtime deploys for
`apps/api` (FR-011, research.md #7); weekly backups (FR-015). No custom
domain is required — spec.md's original "no custom domain name is
required" Assumption holds; CloudFront's own default domain satisfies
FR-005/SC-006 (research.md #3). The EC2 security group accepts inbound
traffic only from CloudFront's IP ranges (research.md #4) — this also
means CORS is not needed in production (same-origin via CloudFront),
though the existing local-dev CORS config (`apps/api`'s `enableCors`)
stays unchanged since local dev still runs web/api on different ports.

**Scale/Scope**: Single EC2 instance, single production environment,
single maintainer — matches spec 001's own personal/low-concurrency
framing.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is still the unfilled template (same
state as when spec 001 was planned) — there are no ratified project
principles to check against. Not blocking for a solo project.

**Result**: PASS (no constitution defined — nothing to violate)

**Post-Phase 1 re-check**: data-model.md and quickstart.md introduce no
new architectural decisions beyond what's captured in Technical Context
and research.md above — PASS, unchanged. `contracts/` was intentionally
not produced (see Project Structure below).

## Project Structure

### Documentation (this feature)

```text
specs/002-deployment-cicd/
├── plan.md              # This file (/speckit-plan command output)
├── research.md           # Phase 0 output (/speckit-plan command)
├── data-model.md         # Phase 1 output (/speckit-plan command)
├── quickstart.md         # Phase 1 output (/speckit-plan command)
└── tasks.md              # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

No `contracts/` directory: this feature adds no new externally-callable
interface (no new REST endpoints, no new request/response schema) — it's
purely operational infrastructure sitting *underneath* the existing
spec-001 API contract, which is unchanged.

### Source Code (repository root)

```text
.github/
└── workflows/
    ├── ci.yml               # Runs the full test suite on every push/PR (FR-002/FR-003)
    └── deploy.yml            # On merge to main: build+push api/worker images to ECR,
                               # build apps/web's static export and sync to S3, CloudFront
                               # invalidation, SSM-trigger the EC2 rollout, post-deploy
                               # smoke test, alert on failure (FR-004/007/011/012)

infra/
├── terraform/                 # AWS resources as code (research.md #5)
│   ├── main.tf                  # EC2 instance, CloudFront-only security group, EBS volume,
│   │                             # IAM role, ECR repos (api/worker), S3 bucket, CloudFront
│   │                             # distribution (2 origins/path-based behaviors, default
│   │                             # *.cloudfront.net domain — no ACM, no Route53), SNS topic +
│   │                             # email subscription, CloudWatch Synthetics canary + alarm,
│   │                             # AWS Backup plan
│   ├── variables.tf
│   └── outputs.tf
├── docker-compose.prod.yml    # Production overlay: pre-built ECR images (no `build:`),
│                               # Caddy service, 2 replicas for apps/api only (research.md #7)
└── Caddyfile                  # Origin-side reverse proxy / load balancer, plain HTTP,
                                # no TLS (research.md #3)

docker-compose.yml              # Existing local-dev compose (spec 001) — unchanged
apps/, packages/                # Existing application code (spec 001) — unchanged except
                                 # apps/web's /workouts/[id] → /workouts?id= (research.md #1)
```

**Structure Decision**: All new work lives under `.github/workflows/` and
`infra/`, kept separate from `apps/`/`packages/` — this feature is purely
CI/CD pipeline configuration and infrastructure-as-code, with exactly one
small routing change to existing application source (`apps/web`'s
dynamic workout route) required to make static export work.

## Complexity Tracking

*No constitution violations to justify — section intentionally empty.*
