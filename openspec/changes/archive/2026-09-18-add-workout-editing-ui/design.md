# Design

## Context

See proposal.md — Why. The constraints that actually shape this design:

- **apps/web is `output: 'export'`.** No SSR, no route handlers, no dynamic
  route segments that would need `generateStaticParams` over user data. `/workouts`
  already addresses one workout as `/workouts?id=<uuid>` for exactly this reason.
- **apps/web may import only *types* from packages/shared.** A runtime import
  drags the barrel's ioredis/amqplib/mongoose into the browser build. The
  existing precedent is `services/event-stream.ts`, which restates the
  notification type strings as literals with a `satisfies` check rather than
  importing them.
- **No jsdom in apps/web's vitest setup**, by an explicit earlier decision. Only
  pure modules (`lib/`, `services/`, the event store) are unit-testable; nothing
  renders a component in a test. Anything component-level is verified in a real
  browser.
- **`PUT /api/workouts/:id` is already built** and is the contract this UI is
  written against: whole-workout replacement, order by array position, `400`
  with `unresolved_exercises`, `409`, `404`, `503`, and the edited workout
  returned in the same shape as `GET /workouts/:id`.
- **The workout-log store (`services/workout-events.ts`) is the existing seam**
  for "something changed, refetch". It already carries `workout.updated` through
  `publishRemote`, and `WorkoutUpdatedNotification` deliberately carries no date
  so `weekOf()` returns null — which every consumer already reads as "may
  concern any week".

## Goals / Non-Goals

**Goals:**

- One editing screen that expresses the whole end state of a workout, matching
  the endpoint's replacement semantics rather than fighting them.
- Exercise names that are chosen, not guessed, so the `400` path is the
  exception rather than the normal way to learn what the catalog holds.
- The edit visibly propagates: the editing tab's own lists and charts, and the
  same user's other tabs, without a manual reload.

**Non-Goals:**

- Adding or editing catalog entries (see proposal.md — out of scope).
- Editing a `pending` or `failed` workout; the endpoint refuses both.
- Partial/field-level edits, autosave or draft persistence. One explicit save
  sends one replacement.
- Any change to how the worker recomputes analytics — that path exists and is
  tested.

## Decisions

### D1. Route: `/workouts/edit?id=<uuid>`

A new static route at `app/(main)/workouts/edit/page.tsx`, reading `id` from
`useSearchParams()` inside a `Suspense` boundary — the same shape
`app/(main)/workouts/page.tsx` already uses.

*Alternatives:* `/workouts/[id]/edit` is not available: under `output: 'export'`
a dynamic segment needs `generateStaticParams`, and the id set is user data
unknown at build time. A `?edit=1` mode on `/workouts` avoids a new file but
gives the page a third branch and makes "am I editing?" a state question rather
than an address. A modal over the list keeps the user in place but is not
addressable, loses the edit on reload, and is a poor fit for a form with nested
repeatable rows on a phone.

*Consequence:* one hop each way. The list's edit control links to
`/workouts/edit?id=…`, and a successful save returns to `/workouts?id=…` — the
detail view — which is also what satisfies "the owner is shown the result".

### D2. `GET /api/exercises` returns the whole catalog; matching happens in the browser

The catalog is a seeded reference list of 72 entries (see
`packages/shared/src/db/seed-exercise-catalog.ts`). Serialized with aliases it is
single-digit kilobytes. The endpoint returns all of it, ordered by name; the
browser fetches it once per tab and filters locally as the user types.

*Alternatives:* a `?q=` search endpoint means a request per keystroke (so a
debounce, a race guard, and a spinner inside a text field) to search a list small
enough to hold in memory — all of the cost, none of the benefit at this size.
Paging it has the same problem plus an incomplete local view. Shipping the
catalog as a build-time JSON asset in apps/web would remove the request entirely,
but then a re-seed silently desynchronizes the suggestions from what the server
will accept, and only a redeploy fixes it.

*Bounded on the client, not the server:* with Mongo stopped, the endpoint takes
30s to answer `503` — the driver's default server-selection timeout, which
`PUT /workouts/:id` has always had too. Rather than change that shared timeout,
`listExercises()` aborts after 3s. Suggestions are optional, so giving up on
them early is free; the save path keeps the server's own behavior, because there
the alternative to waiting is losing the edit.

*Revisit when:* the catalog reaches a few thousand entries, or becomes
per-user. Then `?q=` earns its cost. Nothing in the spec forbids adding it
later — the requirement is that a client must not *have* to page or search
server-side, not that it may never.

### D3. Suggestion matching is case-insensitive substring over name + aliases — not the server's normalizer

`resolveExercisesInCatalog` matches on `normalized_aliases`, produced by
`normalizeExerciseName` (token-sorted, singularized). apps/web cannot import that
function at runtime without pulling the shared barrel into the browser bundle.

So the browser matches suggestions by lowercased substring against each entry's
`name` and `aliases`, and choosing a suggestion writes the entry's **canonical
name** into the field — a canonical name always resolves, so a chosen suggestion
can never produce a `400`.

*Alternatives:* re-implementing `normalizeExerciseName` in apps/web is a second
copy of matching logic that drifts silently — the failure mode is suggestions
that stop agreeing with what saves. Deep-importing
`@workout-logging/shared/dist/exercise-match` would work (the package has no
`exports` map) but establishes a bundling pattern this repo does not have, over
a function whose exactness only matters for *resolution*, which stays on the
server.

*Trade-off accepted:* a phrasing the server would resolve but that is not a
literal substring of any alias produces no suggestion. The user can still type
it, and it still saves. Suggestions are a shortcut past the `400`, not a gate in
front of it (spec: "Suggest exercise names the catalog will accept").

### D4. Editor state carries a client-side row id; the wire shape does not

`WorkoutDetail` identifies an exercise and a set only by `order`, and the
replacement body carries no ids at all. Using array index or `order` as a React
key breaks the moment a row is removed or moved: React reuses the wrong input,
focus and caret jump, and a half-typed value lands in a neighbouring row.

The editor therefore holds its own shape — each exercise and each set gets a
`crypto.randomUUID()` row id when the form is built or a row is added. The id is
for keys and for identifying a row within the form only; it is stripped when the
payload is built, and order comes from array position.

The two conversions are pure and live in `lib/` beside the other pure helpers,
so they are the part of this feature that vitest can actually cover:

- `toEditorState(detail)` — `WorkoutDetail` → form state, sorting by `order`
  once so nothing downstream has to.
- `toReplacePayload(state)` — form state → the `PUT` body, positions as order,
  no id fields, `name` trimmed to `null` when empty.
- `validateEditorState(state)` — the local refusals the spec lists (no
  exercises, an exercise with no sets, negative weight, non-positive reps,
  unusable date), returned per row so each can be shown at its field.

### D5. `datetime-local`, not `date`, for `performed_at`

`performed_at` is an instant. `<input type="date">` would force every edited
workout to a single time of day, so opening a workout and saving an unrelated
weight change would silently move its time — and near a week boundary, its ISO
week, which recomputes two weeks' analytics for nothing.

The form uses `<input type="datetime-local">`, converting the stored ISO instant
to a local `YYYY-MM-DDTHH:mm` on load and back with `new Date(local).toISOString()`
on save. Both conversions go in `lib/display/date-display.ts`, beside the
existing formatters and their comment about which of them use which timezone —
that file is already the one place in apps/web that decides timezone questions.

*Note:* the log form's `<input type="date">` is not inconsistent with this. It
is *creating* a workout with no time yet known, and the server owns the default;
this form is *preserving* a time the system already recorded.

### D6. The saving tab announces the edit locally, exactly as create and delete do

A new producer in `services/workout-events.ts`:

```ts
publishWorkoutEdited() → publish({
  origin: 'local',
  changeType: null,
  performedAt: null,
  isoWeek: null,
  settledStatus: null,
})
```

Every field is forced by the existing consumers. `performedAt`/`isoWeek` null
because an edit can move a workout between weeks, and null already means "may
concern any week" to every week-scoped consumer — naming the *new* week would
leave the *old* week's view still listing it. `origin: 'local'` and
`changeType: null` keep the dashboard from navigating (only `own-workout` +
a settled status may move a week) and keep the in-flight surface from mistaking
an edit for an extraction finishing.

This is the same shape as `publishWorkoutDeleted`, but a separate named function
rather than a reuse: the call sites document intent, and the two will not stay
identical if a future consumer needs to tell them apart.

*Why local at all, given the SSE `workout.updated` also reaches this tab:* the
same reason `publishWorkoutLogged` and `publishWorkoutDeleted` exist. The local
publish is immediate and does not depend on the channel being live; the remote
one arrives too and costs a second refetch, which is already what happens today
for a create and a delete.

### D7. Refusals are mapped from the `ApiError` body at one place in the feature

`services/workouts.ts` rule 4 says callers never inspect status codes — but the
form is the one place that must, because the spec requires four distinct
messages. Keeping to the spirit of the rule: `replaceWorkout()` stays a thin
`apiJson` call that throws `ApiError`, and a single pure
`describeReplaceFailure(error)` in the feature turns `ApiError` into
`{ message, unresolvedExercises }`, which the form renders. One function to
test, one place that knows what `unresolved_exercises` is called on the wire.

`401` needs no branch: `apiFetch` already refreshes, and on a dead session
`clearTokens()` notifies `useRequireAuth`, which redirects.

### D8. Call order

The rule in `openspec/config.yaml` asks for the trigger → method sequence when a
flow crosses several files, so it can be carried into the code as a class
comment. This is the flow to record on the edit feature:

```
Edit control (workout-table.tsx | workout-detail.tsx)
  -> /workouts/edit?id=<uuid>
  -> WorkoutEditPage -> WorkoutEditForm({ id })
       mount:
         getWorkout(id)                       null -> "not found"
                                              status not parsed|needs_review -> refuse
         -> toEditorState(detail)
         listExercises()                      failure -> suggestions off, form usable
       save:
         validateEditorState(state)           local refusals, nothing sent
         -> toReplacePayload(state)
         -> replaceWorkout(id, payload)       PUT /api/workouts/:id
              400 | 409 | 404 | 503 -> describeReplaceFailure -> rendered in place
              200 -> publishWorkoutEdited()   -> this tab's lists/charts refetch
                  -> router.push(/workouts?id=<uuid>)

  meanwhile, from the API: outbox -> worker -> recompute both ISO weeks
                                  -> analytics.updated notification
                                  -> SSE -> publishRemote -> charts refetch again
```

The second half is why the analytics number is not necessarily correct in the
same instant the save returns: the recompute is asynchronous behind the outbox
relay and the worker, and the dashboard lands on the right number when
`analytics.updated` arrives. The browser verification has to allow for that, and
must not be written as "assert immediately after save".

### D9. `GET /api/exercises` is its own Nest module

A new `apps/api/src/exercises/` module (controller + service) importing
`MongooseModule.forFeature([{ name: 'ExerciseCatalog', schema: ExerciseCatalogSchema }])`
and `AuthModule` — the same wiring `WorkoutsModule` and `AnalyticsModule`
already use, including the comment about why the schema must be registered in
this module's own DI subtree. A catalog read is not a workout operation, and
hanging it off `WorkoutsController` would put it behind that controller's
ingest-oriented concerns.

The read itself is a `find({}).sort({ name: 1 }).lean()` projected to the wire
shape. A failure is caught and rethrown as `ServiceUnavailableException`, for
the reason the workout replace path already documents: an unreachable Mongo must
never look like an empty catalog.

## Risks / Trade-offs

- **[A user's exercise is genuinely missing from the catalog]** → They cannot
  save that edit at all, and this change deliberately does not fix it. The
  refusal names the exercise, which at least makes the wall legible. Adding to
  the catalog is called out in proposal.md as the follow-up; if that turns out
  to bite in practice it is a small, separate change.
- **[Suggestion matching and server resolution can disagree]** (D3) → Bounded in
  one direction only: a missing suggestion for a name that would have worked.
  The reverse — suggesting something that then fails to resolve — cannot happen,
  because a chosen suggestion inserts a canonical name.
- **[No component tests]** → The form's behavior (rows, focus, error placement)
  is only covered by the browser verification in tasks.md. Mitigated by pushing
  everything with real logic into pure helpers (D4, D7) that vitest does cover,
  leaving the components as thin rendering.
- **[Two refetches per save]** (D6) → Local publish, then the SSE
  `workout.updated`, then `analytics.updated` from the worker. Three refetches
  of a small page at human speed; the same pattern already runs for creates and
  deletes. Not worth a dedup mechanism that would have to know which remote
  notification corresponded to which local action.
- **[An edit racing the parser]** → The status check closes it: the endpoint
  re-reads the status under a pessimistic lock inside the transaction, so a
  workout that became non-editable between load and save is refused with `409`,
  which the form reports and then stops offering to save.
- **[Losing a long edit to a transient failure]** → The spec requires the form
  to keep its content on every refusal, including `503`, so a retry is a click.
  Nothing is persisted across a reload, which stays acceptable because the
  screen is reached in one hop from the workout it edits.

## Migration Plan

Nothing to migrate. No schema change in Postgres or MongoDB, no new environment
variable, no Terraform apply. `GET /api/exercises` is additive, and the web
route is new. Rollback is reverting the deploy; a client that predates
`GET /api/exercises` never calls it, and a client that postdates it treats a
`404`/`503` from it as "no suggestions" (D3, spec: the editor stays usable when
the catalog cannot be read).

`packages/shared` is not touched — D9's read uses the schema it already exports
— so there is no rebuild ordering to respect in this change.
