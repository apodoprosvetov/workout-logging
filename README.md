# workout-logging

Log workouts from free-text / photos; a Telegram bot and a web UI on top of a
NestJS API. npm-workspaces monorepo.

| Workspace | What it is |
|---|---|
| `apps/api` | NestJS HTTP API (`/api/*`). Two replicas in production. |
| `apps/worker` | Background consumer (RabbitMQ). No HTTP surface. |
| `apps/web` | Next.js **static export** (`output: 'export'`) — no server, just files on S3. |
| `packages/shared` | TypeORM entities, Mongoose schemas, DB clients, migrations. Consumed as a built package (`dist/`), so build it before the apps. |

## Local development

```bash
cp .env.example .env          # defaults already match docker-compose.yml
npm ci
npm run build --workspace=@workout-logging/shared
npm run migration:run --workspace=@workout-logging/shared
npm run dev                   # predev brings up Postgres/Mongo/Redis/RabbitMQ via docker compose
```

- API on `:3000`, web on `:3001`.
- `npm test` runs the Vitest/Supertest suites against the real containers (not mocked).
- Same suite runs in CI (`.github/workflows/ci.yml`) on every PR, plus a `gitleaks`
  secret scan. On a push to `main`, `deploy.yml` runs `ci.yml` first (via
  `workflow_call`) and only deploys if it passes — a red suite blocks the deploy.

## Architecture (production)

```
                 ┌─────────────── CloudFront (*.cloudfront.net, AWS default cert) ───────────────┐
                 │  default behavior  → S3 bucket (apps/web static export)                        │
                 │  /api/*  behavior  → EC2 origin, plain HTTP :80, caching disabled              │
                 └───────────────────────────────────┬───────────────────────────────────────────┘
                                                     │  (security group: inbound :80 from
                                                     │   CloudFront's prefix list ONLY — no :22,
                                                     │   no 0.0.0.0/0; deploys go through SSM)
                                       ┌─────────────▼─────────────┐
                                       │ EC2 t3.small, eu-central-1 │
                                       │ Caddy → api-1 / api-2      │  ← rolling restart, one at a time
                                       │ worker                    │
                                       │ postgres mongo redis      │  ← bind-mounted to /mnt/data
                                       │ rabbitmq                  │     (separate EBS volume, backed up)
                                       └───────────────────────────┘
```

Everything is `docker compose` on one instance (`infra/docker-compose.prod.yml`).
Images are pulled from ECR by commit SHA — the instance never builds.

## Deploy

Push to `main` → `.github/workflows/deploy.yml` runs automatically:

0. Run the full CI suite (`ci.yml` via `workflow_call`). If it fails, the deploy
   job is skipped — nothing ships. Skipped for `workflow_dispatch` rollbacks.
1. Build & push `apps/api`, `apps/worker` images to ECR, tagged with the commit SHA.
2. Build `apps/web`, `aws s3 sync` to the web bucket, invalidate CloudFront.
3. Over SSM (no SSH): `git checkout` the SHA on the instance, `docker compose pull`,
   run TypeORM migrations, then restart `api-1` then `api-2` one at a time —
   Caddy keeps serving from the other replica, so no request is dropped.
4. Smoke test: `GET /api/health` through CloudFront must return 200 or the run fails.

Datastore containers (`postgres`/`mongo`/`redis`/`rabbitmq`) are only touched when
`infra/docker-compose.prod.yml` itself changes; Caddy only restarts when
`infra/Caddyfile` changes.

### Logs

`apps/api` and `apps/worker` emit one JSON object per line (`{ts, level, svc, msg, …}`)
to stdout/stderr — `docker compose -f infra/docker-compose.prod.yml logs -f api-1 | jq`,
or `… | jq 'select(.level=="error")'` for just the failures. `svc` is `api` or
`worker`; request lines carry `method`/`path`/`status`/`durationMs`/`userId`.

## Rollback

Redeploy an already-built previous version — no new build, no new commit:

```bash
gh workflow run deploy.yml --ref main -f sha=<full-40-char-commit-sha>
```

- `--ref main` picks which copy of the workflow to run; `-f sha=` is what gets deployed.
- The workflow checks ECR: if images for that SHA still exist it skips the build and
  goes straight to the SSM rollout; if they were expired by the ECR lifecycle policy
  (`infra/terraform/ecr.tf`, currently keeps the last 2) it fails with a clear message.
- `apps/web` is rebuilt from that SHA's source (deterministic static export).

## Secrets

**Runtime secrets are NOT in any `.env` file in production.** They live in AWS
Systems Manager Parameter Store as `SecureString` under `/workout-logging/*`, and
`deploy.yml` resolves them into the environment on the instance just before
`docker compose up` — never written to disk.

| Parameter Store (`/workout-logging/…`) | Used by |
|---|---|
| `DATABASE_URL`, `MONGO_URL`, `RABBITMQ_URL` | api, worker connection strings |
| `POSTGRES_PASSWORD`, `MONGO_PASSWORD`, `RABBITMQ_PASSWORD` | the datastore containers' root creds |
| `JWT_SECRET` | api token signing |
| `ANTHROPIC_API_KEY` | api + worker (text/image extraction) |
| `DEPLOY_SSH_PRIVATE_KEY` | deploy.yml only — `git clone/fetch` on the instance |

Local dev uses `.env` (gitignored; template in `.env.example`) with the
docker-compose.yml default credentials. `REDIS_URL` is hardcoded to
`redis://redis:6379` in the prod compose file, so it has no Parameter Store entry.

## Monitoring & alerting

> **Currently disabled** to keep costs down on this test project. The canary was
> ~$10/month — the priciest single piece of the stack. All the code below stays
> in `infra/terraform/`, gated behind `var.monitoring_enabled` (default `false`).
> Set it to `true` and `terraform apply` to bring it back.

- **CloudWatch Synthetics canary** (`infra/terraform/monitoring.tf`) requests
  `https://<cloudfront-domain>/api/health` every 5 minutes.
- A **CloudWatch alarm** on canary `SuccessPercent < 100` publishes to the SNS
  topic `workout-logging-alerts` → email. It notifies only on `OK → ALARM`
  (no spam while down, no "recovered" mail).
- The `workout-logging-alerts` SNS topic + email subscription stay provisioned
  (both free) — only the canary and its alarm/artifact bucket are toggled off.

## Backups

Weekly AWS Backup snapshot of the `/mnt/data` EBS volume (Postgres/Mongo/Redis/
RabbitMQ all persist there), Sundays 03:00 UTC, 30-day retention
(`infra/terraform/backup.tf`).

## Infrastructure

`infra/terraform/` — applied manually, not from CI:

```bash
cd infra/terraform
AWS_PROFILE=workout-logging-deploy terraform plan
AWS_PROFILE=workout-logging-deploy terraform apply
```

The `TerraformDeployPolicy` IAM policy attached to the `terraform-deploy` user is
maintained by hand in the IAM console (it bootstraps Terraform itself, so it can't
live in Terraform). The EC2 instance pins its AMI (`lifecycle { ignore_changes = [ami] }`)
so a new Amazon Linux release never triggers an instance/volume replacement.
