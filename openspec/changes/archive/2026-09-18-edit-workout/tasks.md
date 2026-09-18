# Tasks

## 1. Shared: event type and catalog resolution

- [x] 1.1 Add `WorkoutUpdatedEvent` to `packages/shared/src/events/types.ts` with a body `type` discriminator (`'workout.updated'`), `event_id`, `user_id`, `workout_id`, `previous_performed_at`, `performed_at`, `occurred_at`, plus a `WORKOUT_UPDATED_ROUTING_KEY` constant. Comment why the discriminator is in the body, referencing the retry dead-lettering already documented on `WorkoutDeletedEvent`.
- [x] 1.2 Move catalog name resolution into `packages/shared` as a resolve-only operation that reports, per name, the matched `exercise_catalog` entry or a miss, and creates nothing. Export it from the barrel.
- [x] 1.3 Bind the new routing key: add `bindPrimaryQueue(channel, WORKOUT_ANALYTICS_QUEUE, WORKOUT_UPDATED_ROUTING_KEY)` to `setupRabbitMqTopology` in `packages/shared/src/events/rabbitmq.ts`. Without it the exchange drops the event silently — `publish` sets no `mandatory` flag, so the relay still marks the row published and the reconciliation sweep never re-arms it.
- [x] 1.4 Add `WORKOUT_UPDATED_KEY` and its notification payload to `packages/shared/src/events/notifications.ts`, carrying `workout_id` and deliberately NO date, and add it to the `ChangeNotification` union. An edit can touch two weeks, and a notification claiming one is dropped by every consumer showing the other.
- [x] 1.5 Rebuild shared (`npm run build --workspace=@workout-logging/shared`) so the apps compile against the new exports.
- [x] 1.6 Rewrite `apps/worker/src/parser/exercise-matcher.ts` to build its existing upsert-on-miss behavior on top of the shared resolver, and verify the parser suites still pass unchanged — worker behavior must not move in this change.

## 2. API: the replace endpoint

- [x] 2.1 Add `ReplaceWorkoutDto` under `apps/api/src/workouts/dto/` validating `name` (nullable string), `performed_at` (ISO instant), and a non-empty `exercises` array; each exercise a name plus a non-empty `sets` array; each set `weight` (non-negative), `reps` (positive integer), `unit` (`SetUnit`). Order comes from array position — do not accept an explicit order field.
- [x] 2.2 Add `WorkoutsService.replaceById(userId, workoutId, dto)`: load the workout scoped by `userId` (404 when absent), reject any status other than `parsed` or `needs_review` with 409, resolve every exercise name and reject with 400 naming all misses, then capture `previousPerformedAt` before writing anything. A catalog lookup that fails because MongoDB is unreachable must surface as 503, never as a 400 claiming the names are unknown — follow `IngestionService`'s precedent, including its "nothing was saved" wording.
- [x] 2.3 Implement the transaction in `replaceById`: remove existing sets then workout_exercises (children before parent, matching `deleteById`'s ORM cascade), upsert the `Exercise` rows for resolved catalog entries, insert the new tree with `exerciseOrder`/`setOrder` from array position, update `name`/`performedAt`/`status = parsed`, and insert the `OutboxEvent` carrying both dates — all in one commit.
- [x] 2.4 Publish the new `workout.updated` notification after the commit, outside the transaction boundary — the same placement `deleteById` and the ingestion path use for their own notifications. Do not reuse `workout.settled`: the web client treats a settle as a workout completing extraction.
- [x] 2.5 Return the workout in the same shape `getById` returns, extracting the shared projection rather than duplicating it.
- [x] 2.6 Wire `PUT /workouts/:id` on `WorkoutsController` with `ParseUUIDPipe` on the id, behind the existing `JwtAuthGuard`.
- [x] 2.7 Add the trigger -> method call sequence from design.md as a class comment on `WorkoutsService`, covering the path from the route through the outbox to the worker's two recomputes.

## 3. Worker: recompute both weeks

- [x] 3.1 Teach the analytics handler to recognise `workout.updated` by its body discriminator, alongside the existing `isDeletion` check, without keying off `msg.fields.routingKey`.
- [x] 3.2 On `workout.updated`, recompute the week of `previous_performed_at` and the week of `performed_at`, comparing them with `isoWeekKey` and recomputing once when they are equal.
- [x] 3.3 Confirm the existing retry and dead-letter path handles the new event unchanged — a redelivered `workout.updated` must not be mistaken for a parse.

## 4. Contract tests

- [x] 4.1 Add `apps/api/tests/contract/workouts.replace.spec.ts` covering the success path: name and date change, add/remove/reorder of exercises, add/remove/reorder/edit of sets, response shape matching `getById`, and status becoming `parsed` from both `parsed` and `needs_review`.
- [x] 4.2 Extend that spec with the refusals: 409 for `pending` and for `failed`, 404 for another user's workout and for an unknown id, 400 for an unresolved exercise name (asserting every offending name appears in the body, not just the first), 400 for an empty exercise list, an exercise with no sets, and unusable `weight`/`reps`/`unit` values.
- [x] 4.3 Assert a catalog outage returns 503, not 400, and that the response does not name the submitted exercises as unknown.
- [x] 4.4 Assert the failure paths leave the workout byte-for-byte unchanged and create no catalog entry — read the workout back after each refusal.

## 5. Integration tests

- [x] 5.1 Add an integration test that a replacement moving `performed_at` across an ISO week boundary recomputes both weeks: assert the old week's Redis hash no longer counts the workout and the new week's does.
- [x] 5.2 Add an integration test that a replacement staying within one ISO week recomputes that week exactly once.
- [x] 5.3 Add an integration test that the `OutboxEvent` row is committed in the same transaction as the content: assert no event row exists when the transaction is made to fail, and that a committed replacement always leaves one.
- [x] 5.4 Add an integration test that delivering the same `workout.updated` twice leaves the same weekly volumes as delivering it once.
- [x] 5.5 Add an integration test that a published `workout.updated` actually reaches `workout.analytics.q` — a missing binding is confirmed by the broker and dropped, so assert arrival rather than assuming the publish succeeded.
- [x] 5.6 Add a test that a successful replacement publishes the `workout.updated` notification and not `workout.settled`.

## 6. Verify

- [x] 6.1 Run `npm run docker:up` then `npm test` and `npm run lint`; both clean.
- [x] 6.2 Run `openspec validate --all` and confirm the change is valid.
