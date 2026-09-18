# Design

## Context

Three pieces of existing machinery shape this change.

**The analytics consumer resolves a week by reading the row.** In
`apps/worker/src/analytics/handler.ts`, a `workout.parsed` event carries no date; the
handler loads the workout and recomputes the week of its current `performedAt`. `workout.deleted` cannot do that — the row is gone — so
it carries `performed_at` in the payload instead. An edit is the first operation
where the row still exists but its *previous* week is no longer derivable from
it. Neither existing event shape covers that.

`recomputeWeek` fully recomputes a week from Postgres and overwrites the Redis
hash, so it is already idempotent across redeliveries.

**Two write paths already exist, with different durability.** Ingestion writes
an `OutboxEvent` row inside the same transaction as the workout, and
`OutboxRelayService` publishes it (`FOR UPDATE SKIP LOCKED`, with
`OutboxReconciliationService` sweeping stragglers). Deletion publishes directly
after commit and documents the resulting gap as acceptable, because a lost
deletion event leaves one week stale and the read path falls back to Postgres.

**Catalog matching lives in the worker.** `matchAndUpsertExercise` in
`apps/worker/src/parser/exercise-matcher.ts` resolves a name against
`exercise_catalog.normalized_aliases` in MongoDB and, on a miss, creates a
slugified `Exercise` anyway and reports `matched: false`. The API has no access
to it, and its miss behavior is the opposite of what this change requires.

## Goals / Non-Goals

**Goals:**
- One endpoint that replaces a workout's editable content atomically.
- Analytics correct for both the old and the new ISO week after an edit.
- No edit can leave a workout carrying an exercise outside the catalog.

**Non-Goals:**
- The UI for choosing a catalog entry or adding one. That is the next change,
  and this endpoint's error shape exists to serve it.
- Editing `pending` or `failed` workouts.
- Editing `source`, `hasText`, `hasImage`, `rawInputRef`, or the raw upload in
  MongoDB. An edit corrects the interpretation, never the evidence.
- Recording an edit history or exposing who changed what.
- Reconsidering `performedAtExplicit`. An edit sets `performedAt` deliberately,
  but nothing re-parses a non-`pending` workout, so the flag has no reader on
  this path and is left as it is.

## Decisions

### 1. Carry the previous date on a new event, rather than reusing existing ones

**Decision:** Add `WorkoutUpdatedEvent` to `packages/shared/src/events/types.ts`,
carrying `previous_performed_at` and `performed_at` alongside `workout_id` and
`user_id`, routed to the existing `workout.analytics.q`. The analytics handler
recomputes both weeks, skipping the second when `isoWeekKey` makes them equal.

**The queue binding is new, and its absence fails silently.** `workout.analytics.q`
is bound to a `topic` exchange by explicit per-key bindings — today
`workout.parsed` and `workout.deleted`, with no wildcard. Until
`workout.updated` is bound, nothing reports the gap:
`RabbitMqPublisherService.publish` does not set `mandatory`, so an unroutable
message is still confirmed; `OutboxRelayService` then marks the row published;
and `OutboxReconciliationService` never re-arms it, because it sweeps only
`workout.uploaded` rows whose workout is still `pending`. Both weeks would stay
wrong, with a clean outbox and nothing in the logs — the exact failure Decision 2
exists to prevent. The binding is therefore part of this change, not an
assumption about the topology.

Like `WorkoutDeletedEvent`, it carries a `type` discriminator **in the body**.
The existing comment there explains why: `workout.analytics.q`'s retry tiers
dead-letter with `x-dead-letter-routing-key: workout.parsed`, so a redelivered
event arrives claiming to be a parse. Only the body survives every hop.

**Alternatives considered:**

*Emit two events — a deleted-shaped one for the old week, a parsed-shaped one
for the new.* Reuses everything and adds no type. Rejected: it splits one
logical change into two events, which makes the "same week" case do redundant
work and gives redelivery two independent chances to interleave. Note that a
deleted-shaped event would *not* itself show the UI a deletion — the analytics
consumer publishes only `analytics.updated`, and the user-visible
`workout.deleted` notification comes from `WorkoutsService.deleteById` on a
separate path — so that is not among the reasons.

*Put both weeks in the payload as ISO week strings rather than dates.* Slightly
smaller and removes a conversion. Rejected: every other event carries instants,
and an ISO week string commits the producer to the consumer's bucketing scheme.
If weekly ever becomes monthly, a date still works.

### 2. Use the outbox, not a direct publish

**Decision:** Write the `OutboxEvent` row inside the same transaction that
replaces the workout content, as ingestion does.

A lost analytics event is not self-healing, for a deletion or for an edit:
`AnalyticsService.weeklyVolume` serves a present hash verbatim and recomputes
from Postgres only when the hash is empty, so a stale-but-present hash survives
until the worker's 120-day TTL expires. The existing comment in `deleteById`
claims a cache miss recovers it; that comment is wrong, and this design does not
inherit its optimism.

The asymmetry that justifies the outbox here is scale, not recovery: losing a
deletion event leaves one week overstated, losing an edit event leaves **two**
weeks wrong, and neither corrects itself.

The infrastructure already exists and needs no new component. The cost is one
insert in the transaction and relay latency measured in the relay's poll
interval, which is invisible next to an AI extraction.

**Alternative considered:** publish directly after commit, matching
`deleteById`. Cheaper and consistent with the nearest neighbour. Rejected on the
durability asymmetry above; consistency with the weaker of two patterns is not
worth a silently wrong analytics cache.

### 3. Move catalog matching into `packages/shared`, with strict and lenient behavior separated

**Decision:** Move the catalog lookup into `packages/shared` so both the API and
the worker use one implementation, and split the miss behavior at the call site
rather than inside the matcher:

- a **resolve** operation that returns whether each name matched, creating
  nothing;
- the worker's existing upsert-on-miss, built on top of it, unchanged in
  behavior.

The API resolves every submitted name first; if any did not match, it refuses
the request and names them all, before opening a transaction.

This follows the project constraint that anything used by more than one app
lives in `packages/shared` and is imported, never restated.

**Alternative considered:** give the API its own matcher. Faster to write and
touches no existing code. Rejected: two implementations of name normalization
drift, and the spec requires that a name acceptable from an upload is acceptable
from an edit — which is only guaranteed if it is literally the same code.

### 4. Replace the exercise tree by delete-and-reinsert

**Decision:** Inside the transaction, remove the workout's existing
`WorkoutExercise` and `WorkoutSet` rows and insert the submitted tree fresh,
mirroring the ORM-side cascade `deleteById` already spells out (the FKs are
`ON DELETE NO ACTION`, and TypeORM's relation cascade does not propagate
`remove()` to `@OneToMany` children).

**Alternative considered:** diff the submitted tree against the stored one and
apply the minimum set of inserts, updates and deletes. Preserves row ids and
touches fewer rows. Rejected: the read contract exposes no ids, so there is no
stable identity to diff against — matching by position or by name would be
guesswork, and the guess would be wrong exactly when the user reorders or
renames. Row ids for exercises and sets are not referenced anywhere outside
their own workout, so nothing observable depends on preserving them.

### 5. Reject `pending` and `failed` with 409, distinct from validation

**Decision:** Status ineligibility returns `409 Conflict`; malformed content and
unresolved exercise names return `400 Bad Request`; a workout belonging to
someone else returns `404`, matching the existing "never confirm another user's
data" rule in `WorkoutsService`.

A caller needs to tell "your request was wrong" from "the workout is not in a
state you can edit" — the first is fixed by changing the request, the second by
waiting or not trying.

**Alternative considered:** `422` for the unresolved-exercise case to separate it
from ordinary validation. Rejected: the project has no `422` anywhere, and the
error body names the offending exercises, which is what a client actually
branches on.

### 8. Number exercises and sets from 1

**Decision:** `exerciseOrder` and `setOrder` start at 1, matching what the
parser writes (`apps/worker/src/parser/handler.ts` increments before use).

Not cosmetic: `apps/web` renders `set.order` as the visible set number, so a
0-based edit would make the same workout read "0, 1, 2" after a round-trip
through `PUT` when it read "1, 2, 3" before. One column would mean two things
depending on which writer touched the row last.

### 9. Lock the workout row inside the transaction

**Decision:** Re-read the workout with `pessimistic_write` inside the
transaction, re-check its status there, and delete children by `workout_id`
rather than by ids from a snapshot read outside it.

Decision 6 accepts that concurrent edits lose one of the two. It does not — and
must not — accept what happens without this: both requests delete the rows
*their own snapshot* saw and insert their own tree, the second delete matches
nothing and raises no error, and the workout ends up carrying both trees. That
is corruption, not a lost update, and the user sees every exercise twice.

The status guard moves inside the lock for the same reason: checked against a
snapshot, it can pass for a state the transaction never re-validates.

### 6. No optimistic concurrency in this change

**Decision:** Last write wins between two concurrent edits. No version column,
no `If-Match`.

The `pending` guard already covers the dangerous race — the parser worker
overwriting a user's correction. What remains is one user editing the same
workout from two places at once, which for a personal workout log is rare and
self-inflicted, and whose worst outcome is that one of two edits the same person
made is lost.

Adding a version column means a TypeORM migration and a deploy-time human step
for a race that has not been observed. This is the reversible choice: the column
can be added later without changing the endpoint's shape.

**Risk accepted, not dismissed** — see Risks below.

### 7. Announce the edit with a new `workout.updated` notification

**Decision:** Add `WORKOUT_UPDATED_KEY` to
`packages/shared/src/events/notifications.ts` and publish it over Redis pub/sub
after the commit, carrying `workout_id` and `performed_at` like its neighbours.

**Alternatives considered:**

*Reuse `workout.settled`.* Adds no type and the dashboard already reacts to it.
Rejected: `workout.settled` is published today only by the parser
(`apps/worker/src/parser/handler.ts` and `retry.ts`), and `apps/web` gives it
load-bearing meaning — `settledStatus` is non-null only for a settle, an
`own-workout` settle is the one case allowed to move the dashboard's week, and
the id is drained from `loggedInThisTab`. An edit would produce a settle for a
workout that was never in flight, making one signal mean two things.

*Send nothing and let the worker's `analytics.updated` stand in.* Simplest.
Rejected: `analytics.updated` says the numbers moved, not that this workout's
content changed, so another open tab would keep rendering stale exercises and
sets.

**apps/web needs one line, contrary to an earlier draft of this decision.**
`publishRemote` does narrow on a property rather than the type, so nothing can
mistake an update for a settle — but that is downstream of
`event-stream.ts`'s `NOTIFICATION_TYPES`, a hardcoded runtime allowlist that
`dispatch` checks first. A type missing from it is discarded before any
consumer sees it. The Set is literals by necessity (importing the shared barrel
at runtime breaks the browser build), and it is typed `ReadonlySet<NotificationType>`,
so a missing member is not a type error. `'workout.updated'` is therefore added
to that Set as part of this change. How the editing UI should react beyond a
refresh still belongs with the editing UI.

**The notification carries no date.** Every week-scoped consumer drops a
notification whose week is not the one on screen, so a dashboard showing the
week a workout LEFT would keep listing it. `weekOf()` returns null when neither
`iso_week` nor `performed_at` is present, which already means "may concern any
week" — the honest claim for an edit that can touch two.

## Call order

The whole flow, for carrying into `WorkoutsService` as a class comment:

```
PUT /api/workouts/:id
  WorkoutsController.replace
    -> WorkoutsService.replaceById(userId, workoutId, dto)
         -> workoutRepository.findOne({ id, userId })        // 404 if absent
         -> assert status in {parsed, needs_review}          // 409 otherwise
         -> resolveExercises(mongo, names)                   // 400 if any miss
                                                             //   (shared, creates nothing)
         -> capture previousPerformedAt from the loaded row
         -> manager.transaction:
              remove(sets) -> remove(workoutExercises)       // children before parent
              upsert Exercise rows for resolved catalog entries
              insert workoutExercises (exerciseOrder = position)
              insert sets (setOrder = position)
              update workout { name, performedAt, status: parsed }
              insert OutboxEvent { routingKey: workout.updated,
                                   payload: { previous_performed_at,
                                              performed_at, ... } }
         -> notification.publish(workout.updated)            // outside the txn
         -> return same shape as getById

OutboxRelayService.sweep  -> exchange -> workout.analytics.q
  apps/worker analytics handler
    -> isDeletion? no; isUpdate? yes
    -> recomputeWeek(user, previous_performed_at)
    -> recomputeWeek(user, performed_at)     // skipped when same ISO week
    -> publishNotification(analytics.updated)
```

## Data ownership

No new persistent state, and no migration.

- **Postgres** keeps everything the replacement writes — `workouts`,
  `workout_exercises`, `sets` — because it is the system of record for parsed
  workout content and the replacement must be atomic with the outbox row.
- **Postgres** also holds the `outbox_events` row, necessarily: an outbox that
  is not in the same database as the write it accompanies is not an outbox.
- **MongoDB** is read-only here. `exercise_catalog` is consulted for name
  resolution; `raw_uploads` is untouched, because an edit corrects the
  interpretation and never the evidence.
- **Redis** holds the derived weekly-volume hashes. They are not written on the
  request path at all — the worker overwrites them on recompute, as it already
  does.

## Risks / Trade-offs

**Concurrent edits lose one of them silently.** Decision 6 — one of two edits
wins whole; neither is corrupted, which Decision 9 is what guarantees. The
fallback is a version column later, which does not change the endpoint's shape.

**The strict catalog rule makes the endpoint unusable for genuinely new
exercises until the next change ships.** A user whose exercise is not in the
catalog cannot add it through this endpoint by design. Until the catalog-entry
flow exists, their only path is the upload pipeline, which accepts unmatched
names and marks the workout `needs_review`. This is deliberate, and it is the
reason the error names every unresolved exercise rather than just failing.

**Delete-and-reinsert makes every edit write the whole tree.** For a personal
workout log — tens of sets at most — this is immaterial, and it buys correctness
under reorder and rename that a positional diff cannot offer.

**The outbox delays analytics behind the relay's poll.** The UI already learns
about analytics through `analytics.updated` over SSE rather than by polling, so
a delay of the relay interval shows up as the number updating slightly later,
not as a wrong number.

**Two weeks recomputed means two full `computeWeeklyVolume` queries** when a
workout moves across a boundary. Both are bounded by one user's workouts in one
week, and the same recompute already happens on every parse and every deletion.
