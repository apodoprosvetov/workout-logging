# Phase 0 Research: Deployment & CI/CD

Each item below resolves one open technical question implied by spec.md
(and its EC2-over-ECS/Fargate Clarification) before Phase 1 design.

## 1. Where build artifacts come from

- **Decision**: `apps/api` and `apps/worker` are built in GitHub Actions
  and pushed to Amazon ECR (one repository each), tagged with the commit
  SHA — the EC2 instance only ever pulls pre-built images, never builds.
  `apps/web` is different: it has no server-side rendering, no API
  routes, and no server actions (confirmed by inspecting every existing
  page — all client components fetching `apps/api` over HTTP), so it
  builds via Next.js static export (`output: 'export'`) in CI and is
  uploaded directly to an S3 bucket — no image, no container, no ECR
  repository for it at all.
- **Rationale**: The EC2 instance is deliberately small (cost
  constraint). Building three Node/TypeScript services — including a
  Next.js production build — on that same small box risks OOM/slow
  builds degrading the currently-running version; GitHub Actions has
  generous free compute for this instead. For `apps/web` specifically,
  since it's already effectively a static SPA shell, running it as an
  always-on container is pure overhead compared to S3 + CloudFront
  (research.md #3–4) — cheaper, and removes one more process competing
  for the small instance's resources.
- **One code change this requires**: `apps/web`'s dynamic route
  `/workouts/[id]` doesn't work with static export as-is — Next can't
  pre-generate a page for a workout ID that doesn't exist until after
  deploy. Rather than the common (and messy) CloudFront
  custom-error-page SPA-fallback workaround, the route becomes
  `/workouts?id=<uuid>` (a query param, read client-side via
  `useSearchParams()`) instead of a path param — one static HTML/JS
  bundle serves any ID with no special CloudFront routing rules needed.
  Loses "pretty" URLs; acceptable for a personal-scale internal tool.
- **Alternatives considered**: `git pull` + build directly on the EC2
  instance for api/worker — simpler (no registry) but ties deploy time
  and resource usage to build time and slows rollback (research.md #6);
  keeping `apps/web` as a container on EC2 — works, but adds a third
  container competing for the small instance's resources for a service
  that has no reason to run server-side at all.

## 2. How CI triggers the deploy on EC2

- **Decision**: AWS Systems Manager (SSM) Run Command, not SSH. The
  GitHub Actions runner calls the AWS API (via an IAM role/OIDC, no
  long-lived AWS keys stored in GitHub) to run a command on the
  instance; the instance's SSM agent (built into Amazon Linux) executes
  it.
- **Rationale**: No inbound port 22 needs to be open at all — combined
  with research.md #4's CloudFront-only lockdown, the instance ends up
  with a genuinely minimal public attack surface. No SSH key material to
  generate, store as a GitHub secret, or rotate. Access is governed by
  IAM, consistent with FR-008 (no secrets in git/build output).
- **Alternatives considered**: SSH from the runner — simpler mental
  model, but requires managing a private key as a GitHub secret and
  keeping port 22 open publicly.

## 3. TLS: edge termination and the origin certificate

- **Decision**: Two TLS layers, not one. CloudFront terminates the
  public-facing HTTPS connection using an AWS Certificate Manager (ACM)
  certificate — note ACM certs used by CloudFront **must** be requested
  in `us-east-1` regardless of where the rest of the infrastructure
  lives, a real AWS quirk that needs a second, aliased Terraform AWS
  provider. Between CloudFront and the EC2 origin, Caddy still
  terminates TLS with its own certificate — CloudFront validates origin
  certificates by default, so this still needs to be a real, trusted
  cert, not self-signed. Caddy obtains it via Let's Encrypt's **DNS-01**
  challenge against Route53 (not the default HTTP-01), because the
  instance's security group (research.md #4) blocks inbound access from
  everywhere except CloudFront's IP ranges — HTTP-01 would need port 80
  reachable from Let's Encrypt's own validation servers, which this
  lockdown specifically prevents. DNS-01 only needs Caddy to be able to
  create a TXT record via the Route53 API (an IAM permission, not a
  network path), so it works regardless.
- **This also resolves spec.md's domain-name question**: a real DNS
  domain (or subdomain) is required either way — this remains a
  correction to the spec's original "no custom domain name is required"
  Assumption (written before hosting mechanics were known). Recommend
  Route53 as the DNS host specifically, since it's what makes the DNS-01
  flow above straightforward via Terraform/IAM rather than a manual step
  at an external registrar.
- **Rationale**: Keeping origin traffic encrypted (not just
  edge-to-browser) is standard defense-in-depth and is what CloudFront
  expects by default for a custom origin. DNS-01 is the only renewal
  method compatible with an instance that's otherwise fully locked down
  from the public internet.
- **Alternatives considered**: HTTP-01 with a temporarily-opened port 80
  during renewal windows — adds a recurring window of public exposure
  purely to satisfy a certificate renewal, worse than DNS-01 in every
  way once DNS-01 is available; CloudFront configured to skip origin
  certificate validation — not a clean, supported pattern for custom
  origins, avoided.

## 4. Unified CloudFront: one domain, two origins, no CORS

- **Decision**: A single CloudFront distribution in front of both
  origins on one domain — path-based cache behaviors route `/` (and
  other static asset paths) to the S3 bucket (research.md #1), and API
  paths (`/auth/*`, `/workouts/*`, `/telegram/*`, etc.) to the EC2/Caddy
  origin, with caching disabled for those paths (dynamic, per-user
  responses) and all HTTP methods (including POST, needed for the
  Telegram webhook and every write endpoint) allowed through. The EC2
  instance's security group only accepts inbound traffic from
  CloudFront's published IP ranges — never directly from the public
  internet.
- **Rationale**: Because `apps/web` and `apps/api` now share one origin
  domain from the browser's perspective, they're same-origin — **CORS
  is no longer needed in production at all.** `apps/api`'s existing
  `app.enableCors({ origin: webOrigin })` (added for local dev, where
  `apps/web` on :3001 and `apps/api` on :3000 genuinely are different
  origins) needs no code change: it simply becomes inert once deployed,
  since a same-origin browser request never triggers a CORS check in
  the first place. Locking the EC2 security group to CloudFront-only is
  a meaningful security improvement over exposing the instance directly,
  at no extra cost.
- **Alternatives considered**: Two separate domains/subdomains (e.g.
  `app.example.com` for web, `api.example.com` for the EC2 origin) —
  simpler CloudFront configuration (single-origin distributions instead
  of path-based routing), but keeps CORS as a permanent production
  requirement and leaves the EC2 instance's public HTTPS endpoint
  directly internet-facing rather than CloudFront-only.

## 5. Infrastructure as code

- **Decision**: Terraform, covering the EC2 instance, its security
  group (CloudFront-IP-only, research.md #4), the EBS data volume, an
  IAM role (SSM deploy + ECR pulls + Route53 DNS-01 records), the ECR
  repositories (api, worker only — research.md #1), the S3 bucket +
  CloudFront distribution + ACM certificate (`us-east-1` provider alias)
  + Route53 records, the SNS topic + email subscription, the CloudWatch
  Synthetics canary + alarm, and the AWS Backup plan.
- **Rationale**: FR-001 already requires the *application* source under
  version control; the same reasoning applies to the infrastructure that
  runs it — reproducible from a clean AWS account, self-documenting,
  consistent with the project's existing everything-in-git discipline.
- **Alternatives considered**: Manual console setup — faster for a
  one-time setup, but undocumented and unreproducible; AWS CDK/
  CloudFormation — AWS-specific, less portable knowledge than
  Terraform's HCL, no material benefit at this scale.

## 6. Rollback mechanism (FR-007)

- **Decision**: Rollback is the same `deploy.yml` pipeline, re-run
  (manually triggered) with a previous commit SHA / image tag instead of
  building a new one. For `apps/api`/`apps/worker`, Compose is pointed
  at the older ECR image tags and rolled out through the same SSM path
  as a normal deploy. For `apps/web`, rollback is re-syncing the
  previously-built static export to S3 (each build's output can be kept
  under a commit-SHA-prefixed S3 key for exactly this purpose) plus a
  CloudFront invalidation.
- **Rationale**: Directly satisfies FR-007 ("without writing or merging
  new code") — no new commit is needed. Reuses the same health-check
  gating as a normal deploy instead of a separate, less-tested rollback
  path.
- **Alternatives considered**: A dedicated `rollback.yml` workflow —
  needless duplication of the same logic; a manual `docker compose`
  command run by hand — bypasses this plan's health-check gating.

## 7. Zero-downtime deploys on a single instance (FR-011)

- **Decision**: Only `apps/api` needs this treatment now that
  `apps/web` lives on S3/CloudFront (research.md #1) — an S3 sync +
  CloudFront invalidation has no "container restart" moment at all, so
  it's inherently non-disruptive. `apps/api` runs 2 replicas in
  `docker-compose.prod.yml`; Caddy load-balances across them with
  active health checks and only routes to healthy ones. A rollout
  restarts one replica at a time — Caddy keeps serving from the other
  while the first comes back up and passes its health check, then the
  second is restarted the same way. `apps/worker` (no HTTP surface, just
  a RabbitMQ consumer) runs a single replica — a brief restart there is
  acceptable because spec 001's existing idempotency/retry design
  already guarantees no message is lost or double-processed across a
  consumer restart.
- **Rationale**: This is the smallest mechanism that genuinely satisfies
  "no downtime window with an unreachable app" on a single box with no
  load balancer service in front of the compose stack itself — Caddy
  acts as the local load balancer for the one service that still needs
  it.
- **Alternatives considered**: Single replica with stop-then-start —
  has a real (if brief) gap where the API is down; a second parallel EC2
  instance for true blue/green — doubles infrastructure cost,
  disproportionate for a personal project.

## 8. Alerting (FR-010, FR-012, FR-013, FR-014)

- **Decision**: One SNS topic with an email subscription, fed by two
  sources: (a) a CloudWatch Synthetics canary that periodically requests
  the public health endpoint (through CloudFront, the same path a real
  user would take) and alarms on failure, and (b) an explicit
  "notify on failure" step at the end of `deploy.yml`. CloudWatch alarms
  only re-notify on a *state change* (OK → ALARM), satisfying FR-014
  without extra de-duplication logic.
- **Rationale**: Stays entirely within AWS, reuses infrastructure
  already being provisioned via Terraform, and a canary hitting the
  CloudFront URL validates the whole path end-to-end, not just "is the
  EC2 instance up."
- **Alternatives considered**: A third-party uptime monitor
  (UptimeRobot/Healthchecks.io) — simpler initial setup, but a new
  external dependency for something CloudWatch already covers; a full
  OpenTelemetry + self-hosted Grafana/Prometheus/Alertmanager stack —
  the maintainer is open to this for future deeper observability (spec
  Assumptions), but it's real additional infrastructure not justified
  by FR-010/012/013/014's actual scope. Revisit if/when richer
  tracing/metrics become an actual requirement, not before.

## 9. Backups (FR-015, SC-008)

- **Decision**: AWS Backup, with a weekly scheduled snapshot of the EBS
  volume holding the Docker Compose stack's data (Postgres, MongoDB,
  Redis, RabbitMQ all persist to that one volume). Defined and scheduled
  via Terraform.
- **Rationale**: A single whole-volume snapshot is the simplest
  mechanism that satisfies FR-015 with zero custom scripts, cron jobs,
  or S3 lifecycle rules to maintain.
- **Note on scope**: Of the four data stores, only Postgres and MongoDB
  hold data that can't be regenerated — Redis is recomputable cache/
  rate-limit state, and RabbitMQ's durable state is just topology
  already defined in code (`packages/shared`'s idempotent
  `setupRabbitMqTopology`). The whole-volume snapshot backs up all four
  anyway since they share one volume, but this is *why* FR-015 is
  satisfiable without a more surgical per-database backup strategy.
  `apps/web`'s S3 bucket needs no backup consideration of its own — it's
  fully reproducible by re-running the build from source, which is
  already in git (FR-001).
- **Alternatives considered**: Scheduled `pg_dump`/`mongodump` to S3 —
  more surgical, but needs a maintained cron script and a separate
  restore procedure per database — more moving parts than this
  project's scale justifies given AWS Backup already covers the
  requirement in one step.

## 10. Secrets management

- **Decision**: Two distinct secret stores for two distinct lifecycles.
  CI-time secrets (AWS credentials/OIDC role, ECR/SSM/Terraform access)
  live in GitHub Actions encrypted repository secrets. Application
  runtime secrets (`JWT_SECRET`, `ANTHROPIC_API_KEY`,
  `TELEGRAM_BOT_TOKEN`, database passwords) live in AWS Systems Manager
  Parameter Store as `SecureString` values; the deploy step (via SSM,
  research.md #2) resolves them into the instance's runtime environment
  at deploy time, never writing them into a git-tracked file.
- **Rationale**: Directly satisfies FR-008 and the spec's edge case
  "a secret needs to change — must be updatable without touching version
  control": rotating a Parameter Store value doesn't require a new
  commit.
- **Alternatives considered**: A `.env` file placed on the instance once
  by hand — works, but rotation means SSH-ing in manually (undermining
  research.md #2's decision to avoid open SSH access) and leaves no
  audit trail.
