---

description: "Task list for Deployment & CI/CD"
---

# Tasks: Deployment & CI/CD

**Input**: Design documents from `/specs/002-deployment-cicd/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [quickstart.md](./quickstart.md)

**Tests**: Not applicable in the usual sense — this feature's own "tests" are quickstart.md's end-to-end validation steps (push a failing commit, confirm an alert arrives, etc.), run against real infrastructure, not a unit-test suite. No `[Test]` task category is used.

**Organization**: Tasks are grouped by user story (from spec.md, priority order P1→P5) to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story?] [MANUAL?] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US5)
- **[MANUAL]**: Requires the user to act directly, not the agent — an
  account/billing decision, a credential only they should handle, or a
  confirmation only a human can give (clicking an email link, authorizing
  a CLI). Everything else is agent-executable. See "Notes for you" below
  the Dependencies section for the full list gathered in one place.
- File paths follow plan.md's Project Structure: `.github/workflows/`,
  `infra/`, plus one small change inside `apps/web/`.

---

## Phase 1: Setup

**Purpose**: Get the repository itself under version control and hosted.

- [X] T001 Initialize a git repository at the repository root (`git init`) and create a `.gitignore` covering `node_modules/`, `dist/`, `.next/`, `*.tsbuildinfo`, `.env*`, `coverage/`, `.DS_Store` — deviated from the literal `.env*` pattern to `.env` + `.env.local` + `.env.*.local` specifically, since a blanket `.env*` would also ignore `.env.example` (the tracked template file spec 001 relies on, FR-019). Also added Terraform state/vars patterns pre-emptively (specs/002 Phase 2 will add real `.tf` files shortly, and `.tfstate` can contain sensitive values). Verified with `git check-ignore` and `git status`: node_modules/dist/.next/tsbuildinfo/.env correctly ignored across all four workspaces; `.env.example`, `eslint.config.mjs`, `.prettierrc`, application source, `docker-compose.yml`, `package.json` correctly NOT ignored — `git status --short` shows a clean 14-entry top-level listing, no stray build artifacts
- [ ] T002 [MANUAL] Create a genuinely empty repository on GitHub under your account (do **not** let GitHub auto-generate a README, `.gitignore`, or license — those create an initial commit on GitHub's side that the local repo doesn't have, so T003's push would hit a non-fast-forward conflict against T001's already-verified `.gitignore`) and add it as the `origin` remote — the agent has no GitHub credentials/CLI in this environment to do this step itself
- [ ] T003 Stage and commit the existing codebase (spec 001 + this feature's `specs/002-deployment-cicd/` docs), then push to `origin main` (depends on T002 existing)

**Checkpoint**: Code is in GitHub. Nothing AWS-related has to exist yet — Phase 3 (US1) can start here in parallel with Phase 2's AWS provisioning; only Phases 4+ actually need AWS.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared AWS environment every story past US1 needs to exist
before it can be demonstrated for real — EC2, networking, image/asset
storage, the CDN, and disaster recovery. Pure CI-only concerns (US1) don't
need this phase at all.

**⚠️ CRITICAL**: Deploying, rolling back, or alerting on anything (US2–US5) requires this phase complete.

- [ ] T004 [P] [MANUAL] Create/confirm an AWS account and an IAM identity with permissions to provision EC2, S3, CloudFront, ECR, IAM, SNS, CloudWatch, AWS Backup, and Route53 via Terraform — a billing-bearing decision only you can make
- [ ] T005 [P] [MANUAL] Register a domain name (or identify one you already own) to point at the deployment — real money, an external registrar action
- [ ] T006 [P] Initialize the Terraform project: `infra/terraform/providers.tf` (default region `eu-central-1` provider + a second aliased provider pinned to `us-east-1` for the ACM certificate, per research.md #3), `infra/terraform/variables.tf`
- [ ] T007 [P] Terraform: EC2 instance, its security group (inbound restricted to CloudFront's published IP ranges only, research.md #4), and its EBS data volume in `infra/terraform/main.tf`
- [ ] T008 [P] Terraform: IAM role for the instance (SSM managed-instance core + ECR pull) and a separate IAM role/OIDC trust for GitHub Actions (ECR push, S3 sync, CloudFront invalidation, SSM Run Command — research.md #2) in `infra/terraform/main.tf`
- [ ] T009 [P] Terraform: ECR repositories for `apps/api` and `apps/worker` only — not `apps/web` (research.md #1) in `infra/terraform/main.tf`
- [ ] T010 [P] Terraform: private S3 bucket for `apps/web`'s static export, accessible only via CloudFront Origin Access Control (research.md #1) in `infra/terraform/main.tf`
- [ ] T011 Terraform: CloudFront distribution with two origins — S3 (path `/*` default, cached) and the EC2 instance (API paths, caching disabled, all HTTP methods allowed), the ACM certificate from the `us-east-1` provider alias, and Route53 records pointing your domain (T005) at the distribution (research.md #3–4) in `infra/terraform/main.tf` — depends on T006, T007, T010
- [ ] T012 [P] Terraform: AWS Backup plan with a weekly schedule targeting the EBS volume from T007 (research.md #9) in `infra/terraform/main.tf`
- [ ] T013 [MANUAL] Run `terraform init && terraform plan && terraform apply` in `infra/terraform/` against the AWS account from T004, using credentials only you hold — this provisions real, billed AWS resources and should not be run without you reviewing the plan first
- [ ] T014 [MANUAL] Confirm the SNS email subscription created by T013 by clicking the confirmation link AWS sends — only a human with inbox access can do this
- [ ] T015 [MANUAL] Populate AWS Systems Manager Parameter Store (`SecureString`) with the application runtime secrets already listed in `.env.example` — `JWT_SECRET`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, database passwords (research.md #10) — entering real secret values is something you should do directly, not relay through the agent
- [ ] T016 [MANUAL] Add the GitHub Actions repository secrets/variables that `deploy.yml` (Phase 4) will need: the AWS OIDC role ARN from T008, ECR repository URIs, the S3 bucket name, the CloudFront distribution ID, the EC2 instance ID for SSM targeting, and the SNS topic ARN — set via the GitHub UI (or your own authenticated `gh` CLI), not through the agent

**Checkpoint**: AWS environment exists, is reachable at your domain (once something is deployed to it), and is backed up. US2 can now begin for real.

---

## Phase 3: User Story 1 - Automated testing on every push (Priority: P1) 🎯 MVP

**Goal**: Every push runs the full existing test suite automatically, and a failure blocks anything downstream.

**Independent Test**: Push a change that breaks an existing test; confirm the failure is reported automatically. This story needs nothing from Phase 2 — it only needs Phase 1 (the repo on GitHub).

### Implementation for User Story 1

- [ ] T017 [US1] Create `.github/workflows/ci.yml`: on every push/PR, start `docker-compose.yml`'s Postgres/MongoDB/Redis/RabbitMQ as GitHub Actions services (or via `docker compose up -d`), run `npm run test --workspaces` (spec 001's existing Vitest/Supertest suites) against them, and fail the run (and therefore block any PR merge) on any test failure (FR-002/FR-003)
- [ ] T018 [P] [US1] Add a secret-scanning step to `ci.yml` (e.g. a `gitleaks`-style action) that fails the run if any credential-shaped string is found in the diff — continuous enforcement of FR-008/SC-005, not just a one-time check
- [ ] T019 [US1] Push a deliberately failing commit on a branch to confirm `ci.yml` reports failure automatically (SC-001), then revert and confirm success — the story's own Independent Test, executed for real

**Checkpoint**: User Story 1 is fully functional on its own — no AWS needed.

---

## Phase 4: User Story 2 - Automatic deployment to a live, public environment (Priority: P2)

**Goal**: An approved, merged change becomes live at the public domain automatically, over HTTPS, with no downtime and no manual step.

**Independent Test**: Merge an approved change and, without any manual deploy action, confirm the running public application reflects it within 15 minutes (SC-002).

### Implementation for User Story 2

- [ ] T020 [P] [US2] Add `output: 'export'` to `apps/web/next.config.ts` (research.md #1)
- [ ] T021 [US2] Refactor `apps/web/app/workouts/[id]/` (`page.tsx` + `workout-detail.tsx`) into `apps/web/app/workouts/page.tsx`, reading the workout id via `useSearchParams()` instead of a route param, and update `apps/web/app/dashboard/page.tsx`'s link from `/workouts/${id}` to `/workouts?id=${id}` (research.md #1) — depends on T020
- [ ] T022 [P] [US2] Write `infra/Caddyfile`: reverse-proxies to `apps/api`'s replicas with active health checks, obtains its TLS certificate via Let's Encrypt DNS-01 against Route53 rather than the default HTTP-01 (research.md #3)
- [ ] T023 [US2] Write `infra/docker-compose.prod.yml`: `apps/api` (2 replicas, pre-built ECR image, no `build:`) and `apps/worker` (1 replica) pulling from ECR, the existing Postgres/MongoDB/Redis/RabbitMQ services, and the Caddy service from T022 (research.md #7)
- [ ] T024 [P] [US2] Write `apps/api/Dockerfile`: multi-stage build from the monorepo root context — install workspace deps, build `packages/shared` then `apps/api` (`nest build`), copy `dist/` + production `node_modules` + `package.json` into a slim final image (e.g. `node:22-slim`) — needed by T026, which builds from this
- [ ] T025 [P] [US2] Write `apps/worker/Dockerfile`: same monorepo-aware multi-stage shape as T024 — build `packages/shared` then `apps/worker` (`tsc`), copy `dist/` + production `node_modules` + `package.json` into a slim final image — needed by T026
- [ ] T026 [US2] Create `.github/workflows/deploy.yml`, triggered on merge to `main`: build and push `apps/api`/`apps/worker` images to ECR (using the Dockerfiles from T024/T025) tagged with the commit SHA; build `apps/web`'s static export (T020) and sync it to the S3 bucket under a commit-SHA-prefixed key, then invalidate the CloudFront cache; over SSM Run Command, have the EC2 instance pull `infra/docker-compose.prod.yml` + `infra/Caddyfile` and the new image tags and roll out (FR-004)
- [ ] T027 [US2] Add a post-deploy smoke test step to `deploy.yml`: HTTP request the live CloudFront URL and fail the run (without marking the new version as swapped in) if it doesn't respond successfully — gates FR-011's "confirm healthy before switching"
- [ ] T028 [US2] Merge a real change to `main` and confirm it is live at your domain within 15 minutes with no manual step, no failed request during the rollout, and a trusted (non-self-signed) HTTPS connection (SC-002, SC-006) — the story's own Independent Test

**Checkpoint**: User Stories 1 AND 2 both work independently — the application is genuinely live.

---

## Phase 5: User Story 3 - Public endpoint reachable by an external service (Priority: P3)

**Goal**: The deployed application exposes a stable public HTTPS endpoint a third-party service (Telegram) can call directly, not just a URL a human browses to.

**Independent Test**: From outside the deployment environment, send a direct HTTPS POST (not a browser) to a real API endpoint and confirm it responds successfully.

### Implementation for User Story 3

- [ ] T029 [US3] Verify (and adjust if needed) the CloudFront cache behavior for API paths from T011: confirm `POST`/`PUT`/`DELETE` are in its allowed methods and caching is fully disabled for those paths, in `infra/terraform/main.tf`
- [ ] T030 [US3] From an external network, `curl -X POST` a real endpoint (e.g. `/auth/register`) at your domain and confirm success, then inspect the certificate presented and confirm it's the trusted ACM certificate (SC-006) — the story's own Independent Test; also stands in validation for the not-yet-built `POST /telegram/webhook` (spec 001, T038–T041), which will reach the same CloudFront→EC2 path once it exists

**Checkpoint**: User Stories 1–3 all work independently.

---

## Phase 6: User Story 4 - Recovering from a bad deploy (Priority: P4)

**Goal**: The maintainer can restore the previous working version quickly, without writing new code first.

**Independent Test**: Deploy a version, then trigger a rollback to the prior version, and confirm the previous version is live again within 10 minutes.

### Implementation for User Story 4

- [ ] T031 [US4] Add a manual `workflow_dispatch` trigger to `deploy.yml` (T026) accepting a commit SHA / image tag input, so it can redeploy a previous already-built version (ECR tags, S3 key prefix) through the exact same SSM/health-check path as a normal deploy, instead of building anything new (research.md #6)
- [ ] T032 [US4] Manually trigger `deploy.yml` against a previous commit SHA and confirm the live application matches that version's behavior within 10 minutes (SC-004) — the story's own Independent Test

**Checkpoint**: User Stories 1–4 all work independently.

---

## Phase 7: User Story 5 - Proactive alerting on problems (Priority: P5)

**Goal**: The maintainer is notified automatically (email) when a deploy fails or the live application becomes unreachable, without needing to check anything manually.

**Independent Test**: Deliberately trigger a failure condition and confirm a notification arrives without manual polling.

### Implementation for User Story 5

- [ ] T033 [P] [US5] Terraform: CloudWatch Synthetics canary that periodically requests the live CloudFront URL, and a CloudWatch Alarm on canary failure that publishes to the SNS topic from Phase 2 (T013's applied plan already created the topic; this task adds the canary + alarm) in `infra/terraform/main.tf` (research.md #8)
- [ ] T034 [US5] Add a "notify SNS on failure" step to `deploy.yml` (T026) so a failed deploy run triggers the same email channel as a health-check failure (FR-012)
- [ ] T035 [MANUAL] [US5] Re-apply the Terraform plan from T033 (`terraform apply`, same manual caveat as T013)
- [ ] T036 [US5] Deliberately break the live application's health check (e.g. stop the `apps/api` containers on the instance) and confirm an email arrives within 10 minutes without checking any dashboard first; restore it and confirm no further duplicate emails arrive while already-alarmed, and none once healthy again (SC-007, FR-014) — the story's own Independent Test

**Checkpoint**: All five user stories are independently functional.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Full end-to-end validation and documentation, after every story above works on its own.

- [ ] T037 Run through [quickstart.md](./quickstart.md) top to bottom against the real deployed environment, including the cross-cutting checks (secret history scan, EBS backup recovery-point exists, EC2 unreachable except via CloudFront, `/workouts?id=` renders correctly)
- [ ] T038 [P] Update the repository's top-level README (or add one) documenting the deploy process, how to trigger a rollback (T031), and where runtime secrets live (Parameter Store, not `.env`) for future reference
- [ ] T039 [P] Confirm `.env.example` (spec 001) still lists exactly the secret names populated into Parameter Store in T015, so local dev and production stay in sync

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Phase 1 (needs the repo to exist to eventually deploy it) — BLOCKS User Stories 2–5, but **not** User Story 1.
- **User Story 1 (Phase 3)**: Depends only on Phase 1. Can run in parallel with Phase 2.
- **User Stories 2–5 (Phases 4–7)**: Each depends on Phase 2 being complete. Story 2 is also a practical prerequisite for Stories 3–5 (there's nothing to reach externally, roll back, or alert on until something is actually deployed), even though spec.md scopes them as independently *valuable* — see each phase's own Independent Test for what's genuinely re-testable in isolation once Story 2 exists.
- **Polish (Phase 8)**: Depends on however many of Stories 1–5 you've chosen to complete.

### Parallel Opportunities

- T004/T005/T006 (Foundational) can start together — different concerns (AWS account, domain, Terraform provider setup).
- T007/T008/T009/T010/T012 (Terraform resource blocks) can be drafted in parallel; T011 (CloudFront) needs T007/T010 to exist first since it references them as origins.
- Phase 3 (User Story 1) can be done entirely in parallel with Phase 2 (Foundational) — they touch different files and neither depends on the other.
- T020/T022 (Phase 4) touch different files and can run in parallel; T021 depends on T020.
- T024/T025 (Dockerfiles) are independent of each other and of T020–T023 — can be done in parallel with all of them.

---

## Notes for you (everything marked [MANUAL], gathered in one place)

1. **T002** — create the GitHub repo, add it as `origin`.
2. **T004** — AWS account + IAM identity for Terraform.
3. **T005** — register/identify a domain.
4. **T013** — run `terraform apply` for real (review the plan first).
5. **T014** — click the SNS email confirmation link.
6. **T015** — enter runtime secrets into Parameter Store.
7. **T016** — set GitHub Actions repository secrets/variables.
8. **T035** — re-apply Terraform after the alerting resources are added.

Everything else — every `.tf`/`.yml`/`Caddyfile`/`docker-compose.prod.yml`
file, and the `apps/web` routing refactor — is agent-executable.

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 3: User Story 1 — this alone is a real, working MVP
   (automated testing on every push) and needs none of Phase 2's AWS work.
3. **STOP and VALIDATE**: confirm CI blocks a failing push.

### Incremental Delivery

1. Setup (Phase 1) → Story 1 (Phase 3) → demo: tests run automatically.
2. Foundational (Phase 2, in parallel with or after Story 1) → Story 2
   (Phase 4) → demo: the app is genuinely live.
3. Story 3 (Phase 5) → demo: Telegram-style external reachability proven.
4. Story 4 (Phase 6) → demo: rollback works.
5. Story 5 (Phase 7) → demo: alerting works.
6. Polish (Phase 8).
