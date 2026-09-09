# Event Contract: Real-Time Updates

Extends [spec 001's event contract](../../001-workout-logging-mvp/contracts/events.md).
Transport and fan-out decided in [research.md](../research.md) #1, #2, #4.

Two distinct layers, deliberately not merged:

| Layer | Medium | Durability | Purpose |
|---|---|---|---|
| **Work events** | RabbitMQ `workout.events` topic exchange | durable, retried, dead-lettered | drive background processing |
| **Change notifications** | Redis Pub/Sub | none — dropped if nobody listens | tell open screens to refetch |

Keeping notifications off the work exchange is research #2: an ephemeral UI
concern must not become entangled with retry tiers and the DLQ.

**This feature adds no new work event.** An earlier draft of this contract also
defined `analytics.updated` as a durable RabbitMQ event, published to
`workout.events` and consumed by nothing — existing only to be turned into a
notification. That was struck: it created a binding with no consumer, gave one
concept two incompatible payload definitions, and contradicted research #2 by
putting a notification concern back on the work exchange. The analytics consumer
publishes the notification directly, exactly as it already writes the Redis hash
directly.

The three work events this feature relies on — `workout.uploaded`,
`workout.parsed`, `workout.deleted` — already exist and are unchanged.

---

## 1. Change Notification (Redis Pub/Sub)

### Channel

One channel per user. The channel name is the authorization boundary — a
subscriber receives only the notifications of users it asked for, so a filtering
bug cannot leak across users (FR-005).

```
user-events:{user_id}
```

### Envelope

Every notification shares this shape. Field names are snake_case: this is a JSON
wire payload, consistent with the existing event contracts.

```json
{
  "type": "workout.settled | workout.created | workout.deleted | analytics.updated",
  "event_id": "uuid",
  "user_id": "uuid",
  "occurred_at": "ISO 8601"
}
```

`event_id` lets a recipient recognise a repeat (FR-020). It is not a sequence
number — there is no ordering guarantee and none is needed, because no
notification carries data.

### `workout.settled`

Sent when a workout reaches `parsed`, `needs_review`, or `failed`. This is the
transition that moves it between the two UI surfaces.

```json
{
  "type": "workout.settled",
  "event_id": "uuid",
  "user_id": "uuid",
  "workout_id": "uuid",
  "status": "parsed | needs_review | failed",
  "performed_at": "2026-09-07",
  "occurred_at": "ISO 8601"
}
```

- `performed_at` is the date the workout carries **now**, after any date the
  parser adopted from the submitted text. It is addressing, not payload: it lets
  a dashboard decide whether this concerns the week on screen without fetching
  (FR-004), and it is what makes the parser's date change followable at all —
  the limitation `apps/web/services/workout-events.ts` documents as out of reach.
- The **previous** date is not carried. A screen showing the old week already
  holds the workout and matches on `workout_id`; a screen showing the new week
  never had it.
- `status: failed` still means "settled" in the sense that processing is over —
  but it lands in the in-flight surface, not the lists (FR-014).

### `workout.created`

Sent when a workout row is created, so a user's *other* sessions learn about it
(FR-003, FR-007).

```json
{
  "type": "workout.created",
  "event_id": "uuid",
  "user_id": "uuid",
  "workout_id": "uuid",
  "performed_at": "2026-09-07",
  "occurred_at": "ISO 8601"
}
```

A newly created workout is always `pending`, so `status` is omitted — it would
be a constant.

### `workout.deleted`

Covers both an explicit delete and dismissing a failed workout (FR-014) — they
are the same operation.

```json
{
  "type": "workout.deleted",
  "event_id": "uuid",
  "user_id": "uuid",
  "workout_id": "uuid",
  "performed_at": "2026-09-07",
  "occurred_at": "ISO 8601"
}
```

`performed_at` is the date the workout had when it was deleted, so a dashboard
can tell whether the removal affects the week on screen.

### `analytics.updated`

```json
{
  "type": "analytics.updated",
  "event_id": "uuid",
  "user_id": "uuid",
  "iso_week": "2026-W37",
  "occurred_at": "ISO 8601"
}
```

The dashboard compares `iso_week` against the week it is showing and ignores
anything else (FR-019).

**Note on `iso_week`**: carried rather than derived from a workout, because a
deletion recomputes a week whose workout no longer exists — the analytics
handler already faces this and solves it the same way
(`WorkoutDeletedEvent.performed_at`).

**Published after the Redis pipeline commits**, never before: announcing a
recomputation that could still fail would race a client into refetching figures
that were about to change again. Same reasoning the parser already applies to
`workout.parsed` (`apps/worker/src/parser/handler.ts:48-52`).

---

## 2. Producer map

| Notification | Produced by | Trigger |
|---|---|---|
| `workout.created` | `apps/api` | after `POST /workouts` commits |
| `workout.deleted` | `apps/api` | after `DELETE /workouts/:id` commits |
| `workout.settled` (parsed / needs_review) | `apps/worker` parser | alongside the existing `workout.parsed` publish, after commit |
| `workout.settled` (failed) | `apps/worker` parser | after `markWorkoutFailed`, including the retries-exhausted path |
| `analytics.updated` | `apps/worker` analytics | after the weekly hash pipeline commits |

**Publishing must never fail the underlying change (FR-030).** Every producer
above treats the Redis publish as best-effort: a failure is logged and
swallowed, never propagated into the transaction or the message ack. A workout
that was parsed stays parsed even if nobody could be told.

This mirrors the existing best-effort treatment of `markWorkoutFailed`
(`apps/worker/src/parser/retry.ts:80-84`).

---

## 3. Delivery to the browser

The API replica holding a connection re-emits the notification verbatim as an
SSE frame. The wire format is in [api.md](./api.md); the JSON body is exactly
the envelope above, so there is one payload definition, not two.
