# Proposal

## Why

`PUT /api/workouts/:id` exists and works, but nothing in the product can call
it: a user who sees the AI extraction get an exercise, a weight or a date wrong
can only delete the workout and log it again, losing the original. The endpoint
also refuses any exercise name the catalog does not know, and with no way to
see the catalog a user has no way to find out what it will accept except by
being refused.

## What Changes

- A new `/workouts/edit?id=<uuid>` route in apps/web that loads a workout, lets
  the user change its name, date, exercises and sets, and saves the whole thing
  through `PUT /api/workouts/:id`.
- An **Edit** control on every workout row in the shared workout table (the
  history list and the dashboard's weekly list), and on the workout detail view.
- A new read-only `GET /api/exercises` returning the exercise catalog, so the
  edit form can offer name suggestions instead of letting the user discover a
  rejected name only on save.
- Inline handling of the endpoint's refusals: the 400 body's
  `unresolved_exercises` is mapped back onto the offending rows, a 409 tells the
  user the workout can no longer be edited, a 503 says nothing was saved.
- After a successful save the tab announces the change through the existing
  workout-log store, so this tab's own lists and charts refetch the same way
  they already do for a log or a delete — the `workout.updated` notification
  covers the user's *other* tabs and devices.

Out of scope, deliberately: **adding an entry to the exercise catalog**. The
workout-editing spec already says introducing a catalog entry is an explicit act
belonging to a separate capability, and it needs decisions this change does not
make (who may add one, how it is deduplicated against existing entries, which
muscle groups it counts toward for analytics). A user who needs a missing
exercise is still blocked after this change; that is worth its own proposal.

## Capabilities

### New Capabilities
- `exercise-catalog`: reading the exercise catalog over HTTP, so a client can
  offer the names an edit will accept. Read-only — authoring entries is not
  part of it.

### Modified Capabilities
- `workout-editing`: adds requirements for the user-facing side of an edit —
  which workouts offer editing, what the edit screen must let a user express,
  how each refusal is reported back, and what the rest of the user's open views
  must do once an edit succeeds. Also corrects one existing requirement: the
  spec says the edit announcement carries the date the workout now belongs to,
  and it does not — the notification deliberately carries no date, so that both
  the week the workout left and the week it joined refetch. The spec has been
  wrong about this since the endpoint shipped; the UI is the first consumer that
  depends on it.

## Impact

Affected workspaces:

- **apps/web** — new route `app/(main)/workouts/edit/page.tsx` and a
  `features/workouts/workout-edit-form` feature; `components/workout-table.tsx`
  gains an edit control; `features/workouts/workout-detail.tsx` gains an edit
  link; `services/workouts.ts` gains `replaceWorkout`; a new `services/exercises.ts`;
  `lib/contracts/workouts.ts` gains the request shape; `services/workout-events.ts`
  gains a `publishWorkoutEdited` producer.
- **apps/api** — new `exercises` module exposing `GET /api/exercises`, with a
  contract test under `apps/api/tests/contract/`.
- **packages/shared** — unchanged. The catalog read is a `find`/`sort` in the new
  apps/api service against the already-shared `ExerciseCatalogSchema`; nothing
  needs a new shared helper, so nothing needs rebuilding.
- **apps/worker** — unchanged.
- **infra** — unchanged.

No TypeORM migration: the edit path writes only tables that already exist, and
the catalog lives in MongoDB with no schema change. No new SSM parameter and no
Terraform apply — nothing here adds configuration or infrastructure.
