# Quickstart: Real-Time Updates

**Feature**: 004-realtime-updates | **Date**: 2026-09-09

How to prove this feature works. Scenarios 1–4 run locally against
`npm run dev`; scenario 5 needs two API replicas, which only the production
compose file provides.

---

## Prerequisites

```bash
npm run docker:up        # postgres, mongo, redis, rabbitmq
npm run dev              # shared (watch), api, worker, web
```

The web app is on `http://localhost:3001`, the API on `http://localhost:3000/api`.

> **Before running `apps/api`'s test suite**, stop the dev worker. Its ingestion
> integration test loses a RabbitMQ race to a running worker — a known
> interaction, not a regression.

---

## 1. A workout lands without a reload (US1, SC-001, SC-003)

1. Sign in and open the dashboard.
2. Log a workout, leaving the date field **blank** and including a date in the
   text (e.g. "7 Sep: bench press 3x8 60kg"). This is the case where the parser
   rewrites `performedAt` — the one the old design could not follow.
3. **Expect immediately**: the workout appears in the in-flight modal as
   processing, and is **absent** from the weekly list and from `/workouts`.
4. **Expect within ~3s**, with no reload and no clicks: it disappears from the
   modal, appears in the workout history, and the dashboard moves to the week of
   7 Sep — because this session logged it.
5. **Expect**: the weekly volume figures for that week include it.

**Fails if**: the workout ever appears in a week list while still processing;
the modal still lists it after it settled; the dashboard did not follow it.

## 2. The two dashboard panels agree (FR-010, SC-004)

The defect this fixes predates the feature, so it is worth checking directly.

1. Open the dashboard on the current week and note the volume figures.
2. Log a workout dated **inside** that week.
3. **Expect while it is processing**: the weekly list does not show it, and the
   volume figures do not change. The two panels describe the same set.
4. **Expect once it settles**: both change together.

**Fails if**: at any moment the list shows a workout the chart is not counting.

## 3. A failed workout is honest and dismissible (US1 scenarios 5–6, FR-014)

Force a failure by logging something unparseable (e.g. a few random characters,
or an image with no workout in it).

1. **Expect**: after the parser gives up, the workout stays in the in-flight
   modal marked as failed, with an explanation — it does not vanish, and it does
   not stay "processing" forever.
2. **Expect**: it never appears in the weekly list or the history.
3. Dismiss it.
4. **Expect**: it disappears, and `GET /workouts` no longer returns it —
   dismissal deletes.

Watch the worker log for `parse abandoned (non-retryable)` or
`analytics exhausted retries` to know the terminal state was reached.

## 4. Interruption and idle (US4, SC-007, SC-008)

**Reconnect after a drop**

1. Open the dashboard. Confirm the channel reports `live`.
2. Kill the API (`Ctrl-C` its dev process). Confirm the UI reports `offline` and
   the page is still fully usable — navigate, open the modal, page through
   history.
3. While it is down, log a workout via `curl` so a change happens unobserved.
4. Restart the API.
5. **Expect within ~10s**: the channel returns to `live` and the screen reflects
   the change made during the outage — nothing is permanently invisible.

**Idle survival**

1. Open a screen and leave it untouched for 30 minutes.
2. Log a workout from another tab.
3. **Expect**: the idle screen updates within the usual window. If it does not,
   the heartbeat is not keeping the stream alive.

**Backoff**

With the API stopped, watch the browser's network panel: reconnect attempts must
space out, not hammer in a tight loop (FR-022).

## 5. Fan-out across replicas (FR-007, research #2)

**This is the scenario that only fails in production-like conditions**, because
locally there is one API process and the bug it catches — a notification
reaching the replica that does *not* hold the connection — cannot occur.

```bash
docker compose -f infra/docker-compose.prod.yml up -d
```

That file runs `api-1` and `api-2` behind Caddy's round-robin
(`infra/Caddyfile`).

1. Open the app in two browsers (or a normal and a private window), signed in as
   the **same** user. With round-robin they will usually land on different
   replicas; confirm via Caddy's logs.
2. Log a workout in one.
3. **Expect**: the other reflects it within ~3s — the in-flight modal shows it,
   then the lists do once it settles.
4. **Expect**: the second window does **not** change week when the workout
   settles. Only the logging session follows it (FR-018).

**Fails if**: only the browser that logged the workout updates. That means the
notification never crossed replicas — the Redis subscription is missing or
scoped wrongly.

## 6. Cross-user isolation (FR-005, SC-011)

1. Sign in as user A in one browser, user B in another.
2. Log a workout as A.
3. **Expect**: B's screen shows no change at all, and B's event stream carries
   nothing about it — check the network panel's EventStream view, not just the
   rendered UI. A notification that arrives and is filtered client-side is a
   **failure**: the channel is the boundary.

---

## Automated coverage

```bash
npm run test --workspace=apps/api      # contract tests (stop the dev worker first)
npm run test --workspace=apps/worker   # publisher unit tests
npm run lint && npm run format:check
```

Contract tests are enumerated in [contracts/api.md](./contracts/api.md).

`apps/web` has no test runner configured, so the client-side SSE frame parser
and reconnect/backoff logic ship with unit tests only if one is added; otherwise
scenarios 1 and 4 are their coverage. Worth deciding during `/speckit-tasks`
rather than discovering at implementation time.
