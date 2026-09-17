# Event Contract: Workout Logging MVP

Exchange/queue topology decided in [research.md](./research.md) #3.
Payload shapes below are the ones proposed in
[design-notes.md](./design-notes.md), except `workout.uploaded` which
drops the `type` field per research.md #8 (unified text/image
ingestion) — the worker now reads `raw_uploads` directly to see which
of text/image are present, rather than being told upfront.

## Exchange

- `workout.events` (topic exchange)

## `workout.uploaded`

- Routing key: `workout.uploaded`
- Queue: `workout.parse.q` (consumer: `apps/worker` parser)
- Published by: `apps/api`, immediately after an ingestion endpoint
  writes the `pending` workout row and the raw upload to MongoDB.

```json
{
  "event_id": "uuid",
  "user_id": "uuid",
  "workout_id": "uuid",
  "raw_upload_ref": "mongo _id",
  "occurred_at": "ISO 8601"
}
```

## `workout.parsed`

- Routing key: `workout.parsed`
- Queue: `workout.analytics.q` (consumer: `apps/worker` analytics)
- Published by: `apps/worker` parser, only when parsing results in
  `status = parsed` or `needs_review` (both carry exercise data worth
  aggregating; `failed` does not publish this event).

```json
{
  "event_id": "uuid",
  "user_id": "uuid",
  "workout_id": "uuid",
  "exercise_count": 5,
  "occurred_at": "ISO 8601"
}
```

## `workout.deleted`

- Routing key: `workout.deleted`
- Queue: `workout.analytics.q` — **the same queue as `workout.parsed`**, bound
  to a second routing key. The consumer and the work are identical (recompute
  one ISO week); a separate queue would only duplicate the retry tiers and DLQ.
- Published by: `apps/api`, after `DELETE /workouts/:id` commits.

```json
{
  "type": "workout.deleted",
  "event_id": "uuid",
  "user_id": "uuid",
  "workout_id": "uuid",
  "performed_at": "ISO 8601",
  "occurred_at": "ISO 8601"
}
```

Two fields carry weight here:

- **`performed_at`** is mandatory and cannot be looked up. By the time this is
  consumed the workout row is gone, so the payload is the only source for the
  week to recompute. `user_id` is in the payload for the same reason.
- **`type`** is the discriminator, and it lives in the body **on purpose**.
  `workout.analytics.q`'s retry tiers are named per primary queue and
  dead-letter with `x-dead-letter-routing-key: workout.parsed`, so a deletion
  that fails once returns to the queue carrying the *parsed* routing key.
  Verified against a live broker. A consumer that discriminated on
  `msg.fields.routingKey` would take the parsed branch, look up a workout that
  no longer exists, and ack without recomputing — leaving the cached week wrong
  indefinitely, silently. Only the message body survives every hop intact; the
  same reasoning drives `x-retry-attempt` being worker-owned rather than read
  from `x-death`.

Why the event exists at all: nothing else invalidates
`weekly_volume:{user}:{week}`. `apps/api` reads that hash and only falls back to
Postgres on a *miss*, so a stale hash is served in full confidence until
something recomputes the week — up to the 120-day TTL.

Publishing happens after the transaction commits, never inside it: a rolled-back
delete must not announce itself. The residual gap — process death between commit
and publish — is left open deliberately; an outbox is disproportionate here, and
the consequence is staleness, not corruption.

## Idempotency

Every consumer MUST check `event_id` against the `processed_events`
table (data-model.md) before doing any side-effecting work, per
research.md #4. This applies even though delivery is already
best-effort-once per queue — RabbitMQ redelivers on nack/timeout/
connection-drop, and the consumer must be safe under that redelivery.

## Retry / DLQ

Per research.md #3: 3 attempts with backoff (5s, 30s, 5m) via retry
queues bound to a dead-letter-exchange back onto the primary queue,
then final failure lands in `workout.dlq`. A message landing in
`workout.dlq` from `workout.parse.q` MUST result in the worker also
marking the workout `failed` in Postgres (best-effort — if that write
itself fails, the DLQ message is still the source of truth for manual
recovery).
