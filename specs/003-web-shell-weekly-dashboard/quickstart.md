# Quickstart: Validating the Web Shell & Weekly Dashboard

Runnable checks that this feature works end to end. Most of it is browser
behaviour that no automated suite in this project covers (research #10), so
these scenarios are the verification — run them, don't skim them.

Request and response shapes live in
[contracts/api-delta.md](./contracts/api-delta.md); the route and chrome
contract lives in [contracts/ui-routes.md](./contracts/ui-routes.md).

## Prerequisites

```bash
npm run dev          # predev brings up Docker Compose and builds packages/shared
```

That starts Postgres, MongoDB, Redis and RabbitMQ, then `apps/api` (port
3000), `apps/worker`, and `apps/web` (port **3001**). API routes are under
the `/api` prefix, so `localhost:3000/api/...`.

Also required:

- Migrations applied, **including this feature's index migration**:
  `npm run migration:run --workspace=@workout-logging/shared`
- MongoDB `exercise_catalog` seeded, so logged workouts reach `parsed`
  rather than `needs_review`.
- `ANTHROPIC_API_KEY` set, or the worker cannot parse and every workout
  stays `pending`. Scenarios below that only check *appearance* still pass
  in that state; scenarios that mention volume do not.

Register once and keep the token for the curl scenarios:

```bash
ACCESS_TOKEN=$(curl -sX POST localhost:3000/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"correct horse battery staple"}' \
  | jq -r .access_token)
```

## Static checks

All three must be clean before the browser scenarios mean anything:

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
npm run lint --workspace=@workout-logging/web
npm run build --workspace=@workout-logging/web
```

The build must still report all five routes as static (`/`, `/dashboard`,
`/login`, `/register`, `/workouts`). A route falling out of static
prerendering means something now needs a server — which the S3 + CloudFront
deployment from spec 002 cannot provide.

## Scenario 1 — One week at a time (FR-001 – FR-005, User Story 1)

Seed three weeks of history, then read them back:

```bash
# This week, last week, and three weeks ago
for OFFSET in 0 7 21; do
  DATE=$(date -u -v-${OFFSET}d +%Y-%m-%d)   # GNU date: date -u -d "-${OFFSET} days" +%Y-%m-%d
  curl -sX POST localhost:3000/api/workouts \
    -H "authorization: Bearer $ACCESS_TOKEN" \
    --form-string "text=Bench press 80kg x8, x8, x6" \
    --form-string "performed_at=$DATE" > /dev/null
done
```

Open `localhost:3001/dashboard`.

**Expected**:

- The label shows the current week's date range.
- The workout list and the volume chart both describe that week only — the
  workouts from 1 and 3 weeks ago are absent.
- One click on the back arrow moves the label back seven days and both
  panels reload together (FR-004).
- Two more clicks back reach the three-weeks-ago workout.
- The forward arrow is disabled on the current week; the back arrow is
  disabled 12 weeks back (FR-003).
- A week with nothing in it says so, in both panels — no error, no blank
  area (FR-008).

## Scenario 2 — Week boundaries hold (FR-005)

The bug this guards against: using Sunday rather than the following Monday
as the exclusive upper bound, which drops everything performed on the
week's last day.

```bash
# Most recent Sunday, in UTC
SUNDAY=$(date -u -v-sun +%Y-%m-%d)
curl -sX POST localhost:3000/api/workouts \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  --form-string "text=Squat 100kg x5, x5, x5" \
  --form-string "performed_at=$SUNDAY"
```

**Expected**: the workout appears in the week containing that Sunday — not
missing, and not in the following week. Verify the same at the other end by
logging one dated the week's Monday.

## Scenario 3 — Logging reaches the screen (FR-011, User Story 2)

This is the gap review found; it is the scenario most worth running.

1. Open `localhost:3001/workouts`. Note what is listed.
2. Click **Log workout** in the header, submit a workout dated **today**.
3. **Expected**: the modal closes and the new workout appears in the list
   **without any page reload**. It will read as not-yet-parsed at first;
   that is correct (FR-013).
4. Repeat from `/dashboard` while the current week is shown: the weekly list
   picks it up the same way.

Confirm the negative too: open the modal, type something, dismiss it with
Escape and with a click outside. Nothing is submitted and the contents are
gone when the modal is reopened (FR-010).

## Scenario 4 — Logging into another week (FR-012)

1. On `/dashboard`, step back two weeks.
2. Log a workout dated **today**.
3. **Expected**: the dashboard switches to today's week and the new workout
   is visible there. It does not stay on the week you were viewing showing
   no change.

## Scenario 5 — Pagination keeps every row (FR-022, User Story 4)

The duplicate-`performed_at` case, which is the whole point of `before_id`.

```bash
# 25 workouts, all on the same date — more than one page, all colliding
for i in $(seq 1 25); do
  curl -sX POST localhost:3000/api/workouts \
    -H "authorization: Bearer $ACCESS_TOKEN" \
    --form-string "text=Set number $i: curl 20kg x10" \
    --form-string "performed_at=2026-03-02" > /dev/null
done
```

Open `localhost:3001/workouts` and page all the way forward, collecting what
you see.

**Expected**: all 25 appear, each exactly once. Before this feature they do
not — the page boundary falls inside the collision and the rows behind it
vanish.

Then page back: each earlier page shows the same rows it showed on the way
forward (User Story 4, scenario 3). The back control is disabled on page 1,
the forward control on the last page (FR-023).

The API half of this is covered by contract tests:

```bash
npm run test --workspace=apps/api
```

## Scenario 6 — A week is never truncated (FR-007)

With the 25 same-day workouts from scenario 5 still present, open the
dashboard on the week containing 2026-03-02.

**Expected**: all 25 are listed. Exactly 20 would mean the request fell back
to the API's default limit (research #4).

## Scenario 7 — Shell and navigation (FR-015 – FR-020, User Story 3)

1. Signed in, on each of `/dashboard` and `/workouts`: the header shows the
   app name, the log action and sign-out; the sidebar marks the current
   section.
2. Move between the two using only the sidebar. **Expected**: no full page
   reload — the chrome stays put and only the content changes.
3. Sign out. **Expected**: `/login`, and again no full document load
   (research #5). The header no longer offers the log action or sign-out
   (FR-020).
4. Sign back in. **Expected**: `/dashboard`, still without a document
   reload.
5. Clear localStorage in DevTools, then open `localhost:3001/dashboard`
   directly. **Expected**: redirected to `/login` with no workout data
   painted at any point, including during hydration (FR-018).
6. With a valid session, open `localhost:3001/`. **Expected**: `/dashboard`,
   never a flash of `/login` (FR-017).
7. Open the app in two tabs, sign out in one. **Expected**: the other stops
   showing personal data.

## Scenario 8 — Consistency (FR-024 – FR-026)

```bash
# The dead config must be gone
test -f apps/web/tailwind.config.js && echo "FAIL: still present" || echo "OK: removed"

# No mixed alias forms left
grep -rn "@/\(features\|components\|services\|hooks\|lib\)/" apps/web --include=*.tsx --include=*.ts \
  && echo "FAIL: mixed alias form" || echo "OK: one convention"

# Every declared alias resolves to a real, non-empty directory
for d in features components services hooks lib; do
  count=$(find "apps/web/$d" -name '*.ts*' 2>/dev/null | wc -l)
  echo "$d: $count files"   # 0 means a declared alias points at nothing
done
```

In the browser, compare a row in the dashboard's weekly list with a row in
`/workouts`: same date format, same status badge, same column alignment
(FR-024). They are one component, so a difference means the extraction is
incomplete.

## Regression check

Spec 001's and 002's behaviour must be intact:

```bash
npm run test --workspaces --if-present
```

And confirm the deployed shape still works — the built export syncs to S3
and is served behind CloudFront with the API at `/api`, so
`NEXT_PUBLIC_API_URL=/api npm run build --workspace=@workout-logging/web`
must produce a working bundle for the same-origin deployment (spec 002).
