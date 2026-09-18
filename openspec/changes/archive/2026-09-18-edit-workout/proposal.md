# Proposal

## Why

A workout reaches its final shape through an AI extraction that is right most of
the time and wrong some of the time. Today the only remedies are to delete the
workout and re-upload it, or to leave it wrong. `needs_review` exists as a status
and nothing can act on it — there is no way to move a workout out of that state.

Editing is also the only way to correct the one field the parser guesses most
often: `performedAt`. A workout logged against the wrong date silently corrupts
the weekly volume analytics for the week it landed in.

## What Changes

- New `PUT /api/workouts/:id` that replaces the editable state of one workout:
  `name`, `performed_at`, and the full ordered tree of exercises and their sets
  (`weight`, `reps`, `unit`).
- Full replacement rather than granular operations. Adding, removing and
  reordering exercises and sets all fall out of sending the desired end state,
  and the existing read contract exposes no exercise or set ids to address.
- Every exercise name in the request MUST resolve to a catalog entry. Names that
  do not match are rejected and named in the error, so no edit can leave a
  workout carrying an exercise outside the catalog. The UI flow for choosing a
  catalog entry or adding a new one is deliberately **not** part of this change.
- A successful edit sets status to `parsed`. This is sound only because of the
  rule above: with no unmatched exercises possible, the `needs_review` condition
  cannot arise from an edit.
- Editable only from `parsed` or `needs_review`. `pending` is rejected — the
  parser worker is still writing to that workout and would overwrite the edit.
  `failed` is rejected — it has no parsed content to edit.
- Weekly-volume analytics are recomputed for **both** the old and the new ISO
  week when `performed_at` moves across a week boundary. Nothing in the current
  system does this: the analytics consumer resolves a workout's week by reading
  the row, which after an edit reports only the new week, leaving the old week
  permanently overstated.

## Capabilities

### New Capabilities
- `workout-editing`: replacing the editable content of an existing workout, the
  validation that governs it, and the analytics recomputation it triggers.

### Modified Capabilities

None. `openspec/specs/` is currently empty — the behavior that already ships
(ingestion, listing, deletion, analytics, real-time updates) was specified under
the earlier `docs/specs-archive/` process and has no OpenSpec capability to
delta against. This change introduces the first one and does not alter any
already-specified requirement.

## Impact

**apps/api** — new route, DTO and validation on `WorkoutsController` /
`WorkoutsService`; catalog resolution moves into a path the API can reach.

**packages/shared** — a new `workout.updated` event type carrying both the
previous and the current `performed_at`, plus the queue binding that routes it
to `workout.analytics.q` (the exchange is `topic` with explicit per-key
bindings, so an unbound key is dropped silently); a new `workout.updated`
notification type for the user's open views; and the exercise-to-catalog
matching currently reachable only from the worker becomes shared.

**apps/worker** — the analytics consumer learns the new event and recomputes two
weeks instead of one.

**apps/web** — one line: `'workout.updated'` joins `NOTIFICATION_TYPES` in
`services/event-stream.ts`, the runtime allowlist that gates every SSE frame.
Without it the notification is discarded before any consumer sees it. Reacting
to the update beyond a refresh belongs with the editing UI, a separate change.

**infra** — none. No new SSM parameter, no Terraform apply.

**Migration** — none expected. The change reuses the existing `workouts`,
`workout_exercises` and `sets` tables and adds no column. If design concludes
that optimistic concurrency needs a version column, that adds a TypeORM
migration and a deploy-time human step; this proposal does not assume it.
