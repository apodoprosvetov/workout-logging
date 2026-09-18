# Spec Delta

## Purpose

Replacing the editable content of a workout that has already been parsed, so a
user can correct what the AI extraction got wrong, and keeping weekly-volume
analytics correct when a correction moves the workout to a different ISO week.

## ADDED Requirements

### Requirement: Replace a workout's editable content

The system SHALL expose `PUT /api/workouts/:id`, accepting a JSON body of the
shape:

```
{
  "name": string | null,
  "performed_at": string,            // ISO 8601 instant
  "exercises": [
    { "name": string,
      "sets": [ { "weight": number, "reps": integer, "unit": "kg" | "lb" } ] }
  ]
}
```

and SHALL apply it as an all-or-nothing replacement of that workout's `name`,
`performed_at`, and complete ordered list of exercises and sets. On success it
SHALL respond `200`.

Order SHALL be taken from array position. The body SHALL NOT carry an explicit
order field for exercises or sets, and the system SHALL reject one if present.

Refusals SHALL use: `400` for a body the system cannot accept, including any
exercise name that does not resolve to the catalog; `409` for a workout whose
status does not permit editing; `404` for a workout that does not exist or
belongs to another user; `503` when a datastore needed to service the request
cannot be reached. Every refusal body SHALL carry a message identifying what was
wrong, and for unresolved exercise names SHALL carry the list of names.

The caller expresses additions, removals and reordering by sending the desired
end state; the system SHALL NOT require the caller to describe the operations
that produce it.

A workout SHALL only ever be replaceable by the user who owns it. A request for
a workout owned by another user SHALL be indistinguishable from a request for a
workout that does not exist.

#### Scenario: Replacing name and date
- **WHEN** the owner submits a replacement carrying a new `name` and a new `performed_at`, and the exercise tree is unchanged
- **THEN** the workout's name and date are updated, its exercises and sets are left equivalent to what they were, and the response reflects the new state

#### Scenario: Adding, removing and reordering in one request
- **WHEN** the owner submits a replacement whose exercise list drops one exercise, introduces another, and places the survivors in a different order
- **THEN** the dropped exercise and all of its sets no longer belong to the workout, the new exercise is present with the sets given, and the stored order matches the order submitted

#### Scenario: Editing sets within an exercise
- **WHEN** the owner submits a replacement that changes a set's `weight`, `reps` or `unit`, adds a set, removes a set, or reorders the sets of an exercise
- **THEN** that exercise's sets match the submitted list exactly, in the submitted order

#### Scenario: Another user's workout
- **WHEN** a user submits a replacement for a workout owned by somebody else
- **THEN** the request is refused as not found, and the response does not reveal that the workout exists

#### Scenario: Replacement fails partway
- **WHEN** the replacement cannot be completed for any reason after it has begun
- **THEN** the workout is left exactly as it was before the request, with no partial application of the new content

### Requirement: Restrict editing to settled, reviewable workouts

The system SHALL accept a replacement only for a workout whose status is
`parsed` or `needs_review`, and SHALL refuse it for any other status, reporting
the conflict distinctly from a validation failure.

A `pending` workout is being written by the extraction pipeline; accepting an
edit would let that pipeline silently overwrite the user's correction. A
`failed` workout has no extracted content to correct.

#### Scenario: Editing a workout still being parsed
- **WHEN** the owner submits a replacement for a workout whose status is `pending`
- **THEN** the request is refused as a conflict, the workout is unchanged, and the response explains that the workout is still being processed

#### Scenario: Editing a failed workout
- **WHEN** the owner submits a replacement for a workout whose status is `failed`
- **THEN** the request is refused as a conflict and the workout is unchanged

#### Scenario: Editing a workout awaiting review
- **WHEN** the owner submits a valid replacement for a workout whose status is `needs_review`
- **THEN** the replacement is applied

### Requirement: Every exercise must resolve to the catalog

The system SHALL resolve each submitted exercise name against the exercise
catalog, and SHALL refuse the entire request when any name does not resolve.
The refusal SHALL name every unresolved exercise, so that a caller can act on
all of them at once rather than discovering them one request at a time.

Resolution SHALL use the same name-matching the extraction pipeline uses, so
that a name acceptable from an upload is acceptable from an edit.

The system SHALL NOT invent a catalog entry for an unresolved name. Choosing an
existing entry or introducing a new one is an explicit act that belongs to a
separate capability; this requirement exists so that no edit can leave a
workout carrying an exercise the catalog does not know.

#### Scenario: An unknown exercise name
- **WHEN** the owner submits a replacement containing an exercise name that does not resolve to a catalog entry
- **THEN** the request is refused as invalid, the workout is unchanged, no catalog entry is created, and the response names the exercise that did not resolve

#### Scenario: Several unknown exercise names
- **WHEN** the submitted replacement contains more than one unresolvable exercise name
- **THEN** the refusal names every one of them, not only the first

#### Scenario: A name that differs from the catalog's spelling
- **WHEN** the submitted exercise name differs from the catalog entry's canonical spelling only in ways the extraction pipeline's matching already tolerates
- **THEN** the name resolves to that entry and the request proceeds

### Requirement: Distinguish an unreachable datastore from a rejected request

The system SHALL NOT report a datastore outage as a fault in the caller's
request. When the exercise catalog cannot be consulted, the system SHALL refuse
the request as a service failure and SHALL NOT report the submitted exercise
names as unresolved.

When the replacement cannot be committed because the system of record is
unreachable, the system SHALL refuse the request as a service failure and SHALL
make clear that nothing was saved.

When the analytics recomputation cannot be handed off at the time of the
request, the system SHALL still accept a replacement that has been committed;
the recomputation is expected to follow once the system recovers, per the
recomputation requirement above.

#### Scenario: The exercise catalog is unreachable
- **WHEN** the owner submits a replacement and the catalog cannot be consulted
- **THEN** the request is refused as a service failure, not as invalid, the response does not claim the exercise names are unknown, and the workout is unchanged

#### Scenario: The system of record is unreachable
- **WHEN** the replacement cannot be committed because the workout store cannot be reached
- **THEN** the request is refused as a service failure and the response makes clear that nothing was saved

#### Scenario: The event broker is unreachable at request time
- **WHEN** the replacement commits but the broker carrying the analytics recomputation is unreachable
- **THEN** the request still succeeds, and the recomputation happens once the broker is reachable again

### Requirement: A successful edit settles the workout as parsed

The system SHALL set a workout's status to `parsed` when a replacement succeeds,
whatever its status was beforehand.

This is sound only because an edit cannot introduce an unmatched exercise: the
condition that would otherwise call for `needs_review` cannot arise from a
replacement.

#### Scenario: Resolving a workout that needed review
- **WHEN** a replacement succeeds for a workout whose status was `needs_review`
- **THEN** its status becomes `parsed`

#### Scenario: Editing an already-parsed workout
- **WHEN** a replacement succeeds for a workout whose status was already `parsed`
- **THEN** its status remains `parsed`

### Requirement: Recompute analytics for every week the edit touches

The system SHALL cause the weekly-volume analytics to be recomputed for the ISO
week the workout belonged to before the replacement AND for the ISO week it
belongs to afterwards.

When those two weeks are the same, the system SHALL recompute that week, and
SHALL NOT be required to recompute it twice.

The recomputation SHALL be driven by the workout's state as committed, and SHALL
NOT depend on reading the workout's current date to learn which week it left —
after a replacement, the stored row no longer carries the previous date.

Recomputation SHALL survive the failure of the process that accepted the
request. A committed replacement whose analytics work is lost leaves both weeks
wrong with nothing to correct them.

#### Scenario: Moving a workout to a different week
- **WHEN** a replacement succeeds and its new `performed_at` falls in a different ISO week than the previous one
- **THEN** the weekly volume for the previous week is recomputed to exclude this workout, and the weekly volume for the new week is recomputed to include it

#### Scenario: Editing without moving weeks
- **WHEN** a replacement succeeds and the new `performed_at` falls in the same ISO week as before
- **THEN** that week's weekly volume is recomputed to reflect the new sets

#### Scenario: Changing sets without changing the date
- **WHEN** a replacement changes only the sets, leaving `performed_at` untouched
- **THEN** the affected week's weekly volume is recomputed

#### Scenario: The accepting process dies after committing
- **WHEN** the replacement has been committed but the process handling the request stops before the analytics work is handed off
- **THEN** the recomputation for both weeks still happens once the system recovers, without user action

#### Scenario: The recomputation is delivered more than once
- **WHEN** the analytics recomputation for a replacement is delivered repeatedly
- **THEN** the resulting weekly volumes are the same as after a single delivery

### Requirement: Announce the edit to the user's other views

The system SHALL announce a successful replacement to the user's open views, as
a change distinct from a workout settling after extraction and distinct from an
analytics recomputation.

A view that does not recognise the announcement SHALL NOT mistake it for a
workout completing extraction.

#### Scenario: Another open view learns of the edit
- **WHEN** a replacement succeeds while the same user has another view open
- **THEN** that view is told this workout changed, carrying enough to know which workout and which date it now belongs to

#### Scenario: The announcement is not a settle
- **WHEN** a view receives the announcement of an edit
- **THEN** it is not reported as a workout settling after extraction, and the workout is not treated as one the view had been waiting on

### Requirement: Validate the submitted content

The system SHALL reject a replacement whose content is not usable, leaving the
workout unchanged, and SHALL describe what was wrong.

At minimum the system SHALL reject: a `performed_at` that is not a valid
instant; a `weight` that is negative; a `reps` value that is not a positive
whole number; a `unit` outside the set the system records; an exercise carrying
no sets; and a replacement carrying no exercises at all.

#### Scenario: An exercise with no sets
- **WHEN** the submitted replacement contains an exercise whose set list is empty
- **THEN** the request is refused as invalid and the workout is unchanged

#### Scenario: A workout with no exercises
- **WHEN** the submitted replacement contains no exercises
- **THEN** the request is refused as invalid and the workout is unchanged

#### Scenario: An unusable set value
- **WHEN** a submitted set carries a negative weight, a non-positive rep count, or a unit the system does not record
- **THEN** the request is refused as invalid, the response identifies the offending value, and the workout is unchanged

### Requirement: Report the edited workout back

On success the system SHALL return the workout's resulting state in the same
shape a caller receives when reading a single workout, so that a client can
render the result without a second request.

#### Scenario: Reading the result of an edit
- **WHEN** a replacement succeeds
- **THEN** the response carries the workout's resulting name, date, status, and its exercises and sets in their stored order, in the same shape as reading that workout directly
