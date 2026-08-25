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
