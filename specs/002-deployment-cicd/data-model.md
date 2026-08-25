# Phase 1 Data Model: Deployment & CI/CD

This feature introduces no new application database tables or documents —
Postgres/MongoDB/Redis/RabbitMQ and every entity in them are unchanged from
spec 001. The "entities" below are the operational concepts named in
spec.md's Key Entities section; each is realized by an existing piece of
the chosen infrastructure (research.md), not by new persisted rows.

## Deployment

Spec definition: a specific, versioned release made live at a point in
time; has a status and is tied to the exact code change it came from.

**Realized as**: for `apps/api`/`apps/worker`, an Amazon ECR image tag
(the commit SHA); for `apps/web`, a commit-SHA-prefixed S3 key holding
that build's static export — combined with a GitHub Actions `deploy.yml`
run. "Status" maps to that workflow run's state (`in_progress` /
`success` / `failure`) plus, post-deploy, the CloudWatch Synthetics
canary's health state for that running version. There is no separate
"Deployment" database row — GitHub's own run history is the record.

| Concept field | Where it actually lives |
|---|---|
| Version identifier | Commit SHA — ECR image tag (api/worker) or S3 key prefix (web) |
| Status (in progress / live / failed / rolled back) | GitHub Actions workflow run status + CloudWatch canary state |
| Tied-to-code-change | GitHub Actions run is triggered by, and linked to, that exact commit/merge |

## Pipeline Run

Spec definition: one execution of the automated test-and-deploy process
triggered by a code change; pass/fail outcome, linked to the Deployment it
produced (if it passed and reached deployment).

**Realized as**: a GitHub Actions workflow run — `ci.yml` for the
test-only stage (every push), `deploy.yml` for the build-and-roll-out
stage (merges to `main` only). GitHub's UI/API is the record of every
run and its outcome; no additional tracking is introduced.

## Environment

Spec definition: the live target the application runs in (single
production environment, per Assumptions).

**Realized as**: one CloudFront distribution on one domain (research.md
#3–4) fronting two origins provisioned by Terraform (research.md #5) —
the S3 bucket (`apps/web`) and the single AWS EC2 instance (one Docker
Compose stack, one EBS volume, one Caddy reverse proxy) running
`apps/api`/`apps/worker` plus the data stores.

## Alert

Spec definition: a notification sent to the maintainer when a monitored
condition is detected; has a trigger condition, delivery channel, and
timestamp; suppressed while an equivalent alert is already outstanding.

**Realized as**: an Amazon SNS notification (email delivery channel),
published either by a CloudWatch Alarm state transition (canary-detected
health failure, research.md #8) or by an explicit step in `deploy.yml`
(deploy failure). The "suppressed while already outstanding" rule is
CloudWatch Alarms' own OK→ALARM state-change semantics — no custom
de-duplication logic is built.

| Concept field | Where it actually lives |
|---|---|
| Trigger condition | CloudWatch Synthetics canary failure, or a failed `deploy.yml` run |
| Delivery channel | Amazon SNS → email subscription |
| Timestamp | SNS notification / CloudWatch alarm timestamp |
| De-duplication | CloudWatch Alarm state-change-only notification behavior |
