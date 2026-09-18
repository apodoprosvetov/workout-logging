# Workout Editing

## Purpose

Replacing the editable content of a workout that has already been parsed, so a
user can correct what the AI extraction got wrong, and keeping weekly-volume
analytics correct when a correction moves the workout to a different ISO week.

## Requirements

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

The announcement SHALL identify the workout and SHALL NOT carry the date it now
belongs to. A date would name exactly one week, and every week-scoped view drops
an announcement whose week is not the one on screen — so a view showing the week
the workout *left* would keep listing it. Carrying no date means "may concern
any week", which is what makes both the week it left and the week it joined
refetch.

#### Scenario: Another open view learns of the edit
- **WHEN** a replacement succeeds while the same user has another view open
- **THEN** that view is told which workout changed, without being told which date it now belongs to, and refetches whatever it is showing

#### Scenario: A view showing the week the workout left
- **WHEN** a replacement moves a workout to a different ISO week while the user has a view of its previous week open
- **THEN** that view refetches and stops listing the workout, rather than dropping the announcement as concerning some other week

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

### Requirement: Offer editing wherever a workout is shown

The web interface SHALL offer a way to start editing a workout from every
surface that shows it to its owner: each row of a workout list, and the
workout's own detail view.

Editing SHALL be offered only for a workout whose status the replacement
endpoint accepts — `parsed` or `needs_review`. A workout that is still being
processed or that failed extraction SHALL NOT present an edit control, because
the request it would start is one the system already refuses.

The edit control SHALL be distinguishable from the delete control on the same
row by more than position, so that a user cannot destroy a workout while
reaching for the way to correct it.

#### Scenario: Editing from the workout history
- **WHEN** the owner views the list of their workouts
- **THEN** every listed workout offers a way to start editing it, distinct from the way to delete it

#### Scenario: Editing from the weekly list
- **WHEN** the owner views a week's workouts on the dashboard
- **THEN** each workout there offers the same way to start editing it

#### Scenario: Editing from the detail view
- **WHEN** the owner opens a single workout
- **THEN** that view offers a way to start editing it

#### Scenario: A workout that cannot be edited
- **WHEN** a workout whose status is `pending` or `failed` is shown to its owner
- **THEN** no edit control is offered for it

### Requirement: The edit screen is addressable and reloadable

The web interface SHALL put editing a workout at its own address, carrying the
identity of the workout being edited, so that the screen survives a reload and
can be reached from a link rather than only from the list it was opened from.

Opening that address SHALL load the workout's current content into the editor.
Until that content has loaded the screen SHALL say so rather than show an empty
form, which would read as a workout with nothing in it.

The address SHALL be reachable in a browser with no server-side rendering
available, since the web application is served as a static bundle.

#### Scenario: Reloading the edit screen
- **WHEN** the owner reloads the page while editing a workout
- **THEN** the same workout is loaded for editing again, with its stored content

#### Scenario: Opening the edit screen for a workout that is not there
- **WHEN** the address names a workout that does not exist or belongs to another user
- **THEN** the screen reports that the workout was not found, offers no editor, and does not reveal whether it exists

#### Scenario: Opening the edit screen for a workout that cannot be edited
- **WHEN** the address names a workout whose status is not `parsed` or `needs_review`
- **THEN** the screen explains that this workout cannot be edited and offers no way to save

#### Scenario: The workout cannot be loaded
- **WHEN** loading the workout to edit fails for a reason other than it being absent
- **THEN** the screen reports the failure and offers to try again, without discarding the address

#### Scenario: Not signed in
- **WHEN** the address is opened without a session
- **THEN** the user is sent to sign in, exactly as every other authenticated screen does

### Requirement: The editor expresses the workout's desired end state

The editor SHALL let the owner change the workout's name, change its date and
time, add an exercise, remove an exercise, reorder exercises, and within an
exercise add, remove, reorder and change sets — each set's weight, repetitions
and unit.

Saving SHALL submit the desired end state of the whole workout, not the
operations that produced it, and SHALL NOT submit an explicit order for
exercises or sets: order is carried by position, and the endpoint refuses a body
carrying an order field.

The editor SHALL NOT submit content the system is known to refuse on its face —
a workout with no exercises, an exercise with no sets, a negative weight, a
repetition count that is not a positive whole number, or a date that is not a
valid instant. It SHALL say which field is wrong, at that field, and leave
everything else the user has typed untouched.

Changes SHALL NOT take effect until the user saves. Leaving the editor without
saving SHALL leave the workout exactly as it was.

#### Scenario: Correcting a misread weight
- **WHEN** the owner changes a set's weight and saves
- **THEN** the workout is stored with that set's new weight and everything else unchanged

#### Scenario: Restructuring the exercise list
- **WHEN** the owner removes one exercise, adds another and moves a third, then saves
- **THEN** the stored workout matches what is on screen, in the order shown

#### Scenario: Moving a workout to another day
- **WHEN** the owner changes the workout's date and saves
- **THEN** the workout is stored on the new date

#### Scenario: Removing the last set of an exercise
- **WHEN** the owner removes every set from an exercise and tries to save
- **THEN** saving is refused locally, the problem is reported at that exercise, and nothing is sent

#### Scenario: Leaving without saving
- **WHEN** the owner changes fields and then leaves the edit screen without saving
- **THEN** the workout is unchanged

#### Scenario: Saving twice
- **WHEN** the owner triggers a save while a save for the same workout is already in flight
- **THEN** only one replacement is sent

### Requirement: Suggest exercise names the catalog will accept

While the owner is naming an exercise, the editor SHALL offer matching entries
from the exercise catalog, matching what has been typed against both an entry's
canonical name and its other accepted spellings.

Choosing a suggestion SHALL put the entry's canonical name into the field, so
that what is submitted is a name the system is known to resolve.

The editor SHALL NOT require a suggestion to be chosen: a typed name that the
system would accept SHALL be accepted, and one it would not is reported by the
refusal requirement below. Suggestion is a shortcut past a refusal, not a second
gate in front of it.

When the catalog cannot be read, the editor SHALL remain usable with no
suggestions rather than block editing. An edit that changed only a weight must
not be prevented by a catalog outage, and the save itself still validates every
name.

The editor SHALL NOT offer to create a catalog entry for a name that does not
resolve. Adding to the catalog is a separate capability, and offering it here
would promise something this system cannot do.

#### Scenario: Typing part of an exercise name
- **WHEN** the owner types part of an exercise name that the catalog knows
- **THEN** matching catalog entries are offered

#### Scenario: Typing an accepted alternative spelling
- **WHEN** what the owner types matches an entry by one of its other accepted spellings rather than its canonical name
- **THEN** that entry is offered

#### Scenario: Choosing a suggestion
- **WHEN** the owner chooses one of the offered entries
- **THEN** the field holds that entry's canonical name, and saving resolves it without a refusal

#### Scenario: The catalog cannot be read
- **WHEN** the catalog cannot be read while the editor is open
- **THEN** no suggestions are offered, the editor stays usable, and a save is still attempted normally

### Requirement: Report a refused save without discarding the user's work

When a save is refused, the editor SHALL keep everything the user has entered on
screen and explain what happened, so that the correction is a small edit rather
than retyping the workout.

The editor SHALL distinguish the refusals the endpoint makes:

- Exercise names that did not resolve SHALL be identified against the exercises
  they were typed into, using the names the refusal lists, and all of them at
  once rather than one per attempt.
- A workout whose status no longer permits editing SHALL be reported as such,
  and the editor SHALL stop offering to save it.
- A service failure SHALL be reported as nothing having been saved, and the save
  SHALL remain retryable.
- A workout that is no longer there SHALL be reported as not found.
- A save refused as invalid for any reason the editor did not anticipate SHALL
  still produce a message the user can read. The system enforces limits the
  editor does not restate — a name's length, a weight's precision, how many
  exercises or sets one workout may carry — and a refusal naming one of them
  SHALL NOT surface as an empty message or as raw diagnostic text.

A service failure SHALL NOT be reported as a problem with what the user typed.

#### Scenario: Two unknown exercise names
- **WHEN** a save is refused because two exercise names do not resolve to the catalog
- **THEN** both exercises are marked on screen, the rest of the form keeps what the user entered, and no changes were saved

#### Scenario: The workout stopped being editable
- **WHEN** a save is refused because the workout's status no longer permits editing
- **THEN** the editor explains that and no longer offers to save

#### Scenario: A service failure while saving
- **WHEN** a save is refused because the system could not service the request
- **THEN** the editor reports that nothing was saved and lets the user try again with the same content

#### Scenario: A refusal the editor did not anticipate
- **WHEN** a save is refused as invalid for a reason the editor does not check for itself, such as a name longer than the system stores
- **THEN** the user is shown a readable explanation rather than an empty or raw one, and everything they entered is still on screen

#### Scenario: The session expired mid-edit
- **WHEN** a save is attempted with a session that has ended and cannot be renewed
- **THEN** the user is sent to sign in, as on every other authenticated screen

### Requirement: A saved edit refreshes everything the user has on screen

After a save succeeds, the tab that made it SHALL announce the change to its own
views, so that the workout lists and the weekly analytics on screen refetch
rather than keep showing the workout as it was.

The announcement SHALL be treated as possibly concerning any week: an edit can
move a workout out of the week a view is showing, and a view that dropped the
announcement for not naming its week would keep listing a workout that left it.

The announcement SHALL NOT be treated as a workout completing extraction, and
SHALL NOT move any screen to a different week on its own.

After the save the owner SHALL be shown the workout's resulting state.

#### Scenario: A list open in the same tab
- **WHEN** a save succeeds while a workout list is open in the same tab
- **THEN** that list refetches and shows the edited workout's new name, date and position

#### Scenario: Analytics open in the same tab
- **WHEN** a save changes the sets of a workout while the weekly volume is on screen in the same tab
- **THEN** the weekly volume refetches

#### Scenario: A workout edited out of the week on screen
- **WHEN** a save moves a workout to a different ISO week while a view of its previous week is open
- **THEN** that view refetches and no longer lists the workout

#### Scenario: The same workout open in another tab
- **WHEN** a save succeeds while the same user has the workout list open in another tab or on another device
- **THEN** that list refetches without the user acting, and does not treat the workout as one that has just finished being processed

#### Scenario: The same edit is announced more than once
- **WHEN** one save produces several announcements — the saving tab's own, the one arriving over the channel, the analytics recomputation that follows, or a repeat after the channel recovers from a gap
- **THEN** every view ends in the same state as after a single announcement, and none of them navigates, double-counts or treats the repeats as separate edits

#### Scenario: Seeing the result
- **WHEN** a save succeeds
- **THEN** the owner is shown the workout as it now stands, without having to look it up again
