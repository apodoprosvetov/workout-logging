# Quickstart: Validating Deployment & CI/CD

Proves each user story end-to-end against the real pipeline/infrastructure
— not a simulation. Uses the concrete decisions in
[research.md](./research.md); see there for why each mechanism was chosen.

## Prerequisites

- Repository pushed to GitHub, with `.github/workflows/ci.yml` and
  `deploy.yml` in place.
- `infra/terraform/` applied at least once (EC2 instance with a
  CloudFront-only security group, EBS volume, ECR repositories, S3
  bucket, CloudFront distribution + ACM cert, Route53 records, SNS
  topic + confirmed email subscription, CloudWatch Synthetics canary +
  alarm, AWS Backup plan all provisioned).
- A domain name's DNS pointed at the CloudFront distribution
  (research.md #3–4), not directly at the EC2 instance.
- Application runtime secrets present in AWS Systems Manager Parameter
  Store (research.md #10).
- GitHub Actions has the AWS role/OIDC credentials needed for ECR push,
  S3 sync, CloudFront invalidation, and SSM Run Command (repository
  secrets).

## Story 1 — Automated testing on every push (P1)

```bash
# On a branch: introduce a deliberately failing test, push, open a PR
git checkout -b quickstart-fail-test
# ...break a test...
git push origin quickstart-fail-test
```

**Expected**: the `ci.yml` workflow runs automatically (no manual
trigger), reports failure on the PR within 10 minutes (SC-001), and
nothing attempts to deploy. Revert the breaking change, push again —
**Expected**: the same workflow reports success.

## Story 2 — Automatic deployment to a live, public environment (P2)

```bash
# Merge an approved, passing change to main
```

**Expected**: `deploy.yml` runs automatically — no manual deploy step.
Within 15 minutes (SC-002), `curl -I https://<your-domain>/` (served via
CloudFront from S3) and `curl -I https://<your-domain>/auth/register`
(routed via CloudFront to the EC2 origin) both return a successful
response over a trusted HTTPS connection (no `-k`/insecure flag needed).
While the API deploy is in progress, repeatedly curl an API path from
another terminal — **Expected**: no failed request during the rollout
(research.md #7's rolling-replica mechanism). A web-only change should
appear noticeably faster than 15 minutes, since it's just an S3 sync +
CloudFront invalidation, no container restart at all.

To confirm the "deploy never causes data loss" scenario, log a workout
before triggering a deploy that includes a migration, then confirm
`GET /workouts` (through the deployed API) still shows it after the
deploy completes.

## Story 3 — Public endpoint reachable by an external service (P3)

```bash
curl -sX POST https://<your-domain>/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"quickstart@example.com","password":"correct horse battery staple"}'
```

**Expected**: a direct HTTPS POST (not a browser) succeeds — proves the
endpoint accepts real inbound requests the same way Telegram's webhook
calls would, once `POST /telegram/webhook` exists (spec 001, T038–T041).
`curl -v` the same URL and confirm the certificate presented is the ACM
certificate CloudFront terminates with (a trusted CA, not self-signed —
SC-006); the origin-side Caddy/Let's Encrypt certificate (research.md
#3) is internal to the CloudFront→EC2 hop and never seen by an external
client directly.

## Story 4 — Recovering from a bad deploy (P4)

```bash
# Manually trigger deploy.yml against a previous commit SHA
```

**Expected**: within 10 minutes (SC-004), the live application matches
the previous working version's behavior exactly — confirm via a response
that only the older version would produce (e.g. a version string, or the
absence of the change just rolled back).

## Story 5 — Proactive alerting on problems (P5)

```bash
# Stop the api service's containers directly on the instance (or make
# the canary's target URL briefly unreachable)
```

**Expected**: within 10 minutes (SC-007), an email arrives at the
subscribed address via the SNS topic, without checking any dashboard
first. Restore the service, wait for the canary to pass again —
**Expected**: no further duplicate alert emails while the outage was
ongoing (FR-014), and no alert at all once healthy.

Separately, trigger a deliberately failing `deploy.yml` run (e.g. an
invalid image tag) — **Expected**: a failure notification arrives via
the same channel.

## Cross-cutting checks

- **Secrets never in git (FR-008/SC-005)**: `git log -p | grep`-style
  scan (or a tool like `gitleaks`) across the full history for any
  known secret value — **Expected**: zero matches.
- **Backups (FR-015/SC-008)**: in the AWS Backup console, confirm a
  completed weekly recovery point exists for the EBS volume. If
  practical, restore that recovery point to a new volume and confirm
  Postgres/MongoDB data is intact and queryable from it.
- **No open SSH** (research.md #2): confirm the security group does not
  allow inbound port 22 from the internet — deploys still work purely
  through SSM.
- **EC2 reachable only via CloudFront** (research.md #4): confirm the
  security group has no rule allowing the public internet directly —
  only CloudFront's published IP ranges.
- **Static export routing** (research.md #1): visit
  `https://<your-domain>/workouts?id=<a real workout id>` in a browser
  and confirm it renders that workout's detail view — proves the
  query-param routing works under static export without any CloudFront
  fallback-routing tricks.
