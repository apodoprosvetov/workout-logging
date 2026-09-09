# API Contract Delta: Real-Time Updates

Changes to [spec 001's API contract](../../001-workout-logging-mvp/contracts/api.md).
One new endpoint, one changed query parameter. Everything else is unchanged.

All paths are under the `/api` global prefix
(`apps/api/src/main.ts:38`).

---

## New: `GET /api/events`

The update channel. One open request per open screen.

**Authentication**: `Authorization: Bearer <access_token>`, enforced by the
existing `JwtAuthGuard` — no bespoke auth path (research #3). The client opens
this with `fetch`, not `EventSource`, precisely so the header can be sent.

**Request**

```http
GET /api/events HTTP/1.1
Authorization: Bearer eyJhbGci…
Accept: text/event-stream
```

**Response**

```http
200 OK
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

`no-transform` and `X-Accel-Buffering: no` are there to stop any intermediary
from buffering the stream into invisibility. CloudFront is configured with
caching disabled for `/api/*` already
(`infra/terraform/cloudfront.tf:104`), so this is belt-and-braces for Caddy and
any future proxy.

**Frames**

Each notification is one SSE event whose `data` is the JSON envelope from
[events.md](./events.md), unchanged:

```
event: workout.settled
data: {"type":"workout.settled","event_id":"…","user_id":"…","workout_id":"…","status":"parsed","performed_at":"2026-09-07","occurred_at":"…"}

```

The `event:` name mirrors the envelope's `type` so a client may dispatch on
either. The blank line terminating each frame is required by the SSE format.

**Heartbeat**

An SSE comment every 15 seconds while otherwise idle:

```
: ping

```

Non-negotiable: CloudFront sets no `origin_read_timeout`
(`infra/terraform/cloudfront.tf:69-74`), so its 30-second default applies
between packets and an idle stream is cut without this (research #9). The client
also uses it as its liveness signal — no traffic for more than two intervals
means the channel is not healthy regardless of what the socket reports (FR-025).

**Status codes**

| Code | When | Client behaviour |
|---|---|---|
| `200` | Stream opened. | Consume frames. |
| `401` | Missing/expired access token. | Refresh via the existing `apiFetch` path and reopen once; on a second `401`, the session is over. |
| `429` | Per-user connection cap reached on this replica (FR-028). | Back off; do not retry tightly. |
| `503` | Notification backend unavailable. | Back off. Screens stay usable (FR-026). |

**Lifecycle**

- The server closes the stream when the connection's token expires; the client
  reopens with a refreshed token. A 15-minute access token
  (`apps/api/src/auth/auth.module.ts:29`) means this is routine, not
  exceptional — reconnection is a normal event, not an error path.
- On close, the server removes the connection from its registry immediately
  (FR-027).
- The client reconnects with exponential backoff and jitter (FR-022), and
  refetches whatever the current screen displays once reconnected (FR-023).

**Not offered**: `Last-Event-ID` resumption. Notifications carry no data, so a
client that missed some only needs to refetch, not replay (research #4). The
header is ignored if sent.

---

## Changed: `GET /api/workouts` — repeatable `status`

**Today**: `status` is a single optional value, applied as
`w.status = :status` (`apps/api/src/workouts/workouts.service.ts:48`) from a
scalar DTO field (`apps/api/src/workouts/dto/list-workouts-query.dto.ts:17`).

**Change**: `status` becomes repeatable and is applied as `IN (…)`.

```
GET /api/workouts?status=parsed&status=needs_review     # the settled lists
GET /api/workouts?status=pending&status=failed          # the in-flight surface
GET /api/workouts?status=parsed                         # unchanged, still valid
GET /api/workouts                                       # unchanged: all statuses
```

**Backward compatible**: a single `?status=x` behaves exactly as before, and
omitting it still returns every status. No existing caller changes meaning.

**Validation**: each value must be a member of the existing `WorkoutStatus`
enum; an unknown value is a `400`, as today. Duplicates are collapsed.

**Why repeated params** rather than `?status=parsed,needs_review`: it keeps the
existing parameter name and type, and `class-validator`'s array handling covers
it without a custom parser.

---

## Unchanged but newly load-bearing

| Endpoint | Why it matters now |
|---|---|
| `GET /workouts/:id` | The refetch target when a `workout.settled` notification concerns an expanded row. |
| `GET /analytics/weekly-volume` | The refetch target for `analytics.updated`. Its Postgres fallback on a cache miss is what makes a dropped notification recoverable. |
| `DELETE /workouts/:id` | Also the dismissal path for a failed workout (FR-014) — dismissing is deleting, not a new operation. |
| `POST /workouts` | Now also the trigger for a `workout.created` notification to the user's other sessions. |

---

## Contract test coverage

Per the standing rule that every new `apps/api` route gets a contract test:

- `GET /api/events` — rejects without a token; rejects with an expired token;
  emits the documented headers; delivers a published notification to a
  subscribed client; delivers *nothing* for another user's notification
  (FR-005 / SC-011); enforces the per-user cap with `429`.
- `GET /api/workouts` — single `status` behaves as before; repeated `status`
  filters to the union; unknown value is `400`; absent `status` returns all.
