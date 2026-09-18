# Workout History

## Purpose

Reading back what a user has logged: their workouts as a paged list, one
workout in full, and removing one they no longer want. This is the read and
delete side of a workout — accepting one is [[workout-ingestion]], replacing its
content is [[workout-editing]].

## Requirements

### Requirement: List a user's workouts

The system SHALL expose `GET /api/workouts`, answering `200` with a page of the
caller's workouts:

```
{
  "data": [
    { "id", "name": string | null, "source", "status",
      "performed_at": string, "created_at": string }
  ],
  "total": integer, "page": integer, "per_page": integer,
  "next_page": integer | null, "prev_page": integer | null
}
```

It SHALL accept `page` and `per_page` with the same meaning and bounds as every
other list route the API exposes, defaulting to the first page and refusing a
`per_page` above the allowed maximum with `400`.

`next_page` and `prev_page` SHALL be null at the ends, so that a client decides
whether a further page exists without arithmetic of its own. A page past the end
SHALL answer `200` with an empty `data` rather than an error, and SHALL NOT
advertise a page beyond it.

#### Scenario: Reading a page
- **WHEN** a user requests their workouts
- **THEN** the response carries that page of workouts, the total count, and the page links

#### Scenario: The last page
- **WHEN** the last page of a user's history is requested
- **THEN** `next_page` is null and `prev_page` names the page before it

#### Scenario: A page past the end
- **WHEN** a page number beyond the last page is requested
- **THEN** the response is `200` with an empty list and no `next_page`

#### Scenario: Too large a page size
- **WHEN** a `per_page` above the allowed maximum is requested
- **THEN** the request is refused with `400`

### Requirement: Order history by when the training happened

The system SHALL order a user's workouts by `performed_at`, newest first — by
when the training happened, not when it was submitted, so that an entry logged
late sorts under its real date.

The ordering SHALL be total: workouts sharing an identical `performed_at` SHALL
be ordered by a further tie-break that is unique per workout. Ties are the
normal case here rather than a rarity, because every workout logged for the same
day through the app carries the same instant; without a total order, paging
silently skips and repeats rows as the database returns tied rows differently
for each page.

#### Scenario: Ordering by training date
- **WHEN** a workout performed last week is submitted today
- **THEN** it appears in the history under last week's date, not at the top

#### Scenario: Paging across identical dates
- **WHEN** a user pages through a history in which many consecutive workouts share an identical `performed_at`
- **THEN** every workout appears exactly once across the pages, with none skipped and none repeated

### Requirement: Filter history by status and by date window

The system SHALL accept `status` on the list route, repeatable, and SHALL return
only workouts at one of the named statuses. An absent `status` SHALL return
every status. An unrecognized status SHALL be refused with `400`.

The system SHALL accept `after` and `before` as bounds on `performed_at`,
forming the half-open window `[after, before)`, so that a caller can request
exactly one ISO week by passing that week's start and the next week's start and
be certain no workout falls in both weeks.

#### Scenario: One status
- **WHEN** the list is requested for a single status
- **THEN** only workouts at that status are returned

#### Scenario: Several statuses at once
- **WHEN** the list is requested for more than one status
- **THEN** workouts at any of those statuses are returned

#### Scenario: A single week
- **WHEN** the list is requested with `after` set to a week's start and `before` set to the next week's start
- **THEN** every workout performed within that week is returned and no workout outside it, and a workout falling exactly on the boundary belongs to exactly one of the two weeks

#### Scenario: An unrecognized status
- **WHEN** the list is requested with a status the system does not define
- **THEN** the request is refused with `400`

### Requirement: Read one workout in full

The system SHALL expose `GET /api/workouts/:id`, answering `200` with the
workout's `id`, `name`, `status`, `source`, `performed_at` and its exercises,
each carrying its name, its position, and its sets with their position, weight,
reps and unit.

Exercises and sets SHALL be returned in their stored order.

#### Scenario: Reading a workout
- **WHEN** the owner requests one of their workouts
- **THEN** the response carries the workout with its exercises and sets in their stored order

### Requirement: Delete a workout

The system SHALL expose `DELETE /api/workouts/:id`, answering `204`, and SHALL
remove the workout together with its exercises and sets. The removal SHALL be
all-or-nothing: a failure partway SHALL leave the workout as it was.

The exercise catalog SHALL NOT be affected by deleting a workout that referenced
it.

The system SHALL cause the weekly volume for the week the workout belonged to to
be recomputed, and SHALL determine that week from the workout as it was before
the removal, since afterwards there is no row left to read a date from.

The system SHALL announce the deletion to the user's other open screens.

#### Scenario: Deleting a workout
- **WHEN** the owner deletes a workout
- **THEN** the response is `204`, the workout and its exercises and sets are gone, and the catalog entries they referenced remain

#### Scenario: The week is corrected
- **WHEN** a workout is deleted
- **THEN** the weekly volume for the week it was performed in is recomputed without it

#### Scenario: Another screen sees the deletion
- **WHEN** a workout is deleted on one device while another device has the app open
- **THEN** the other device reflects the deletion without the user reloading

### Requirement: Every read and every delete is scoped to the caller

The system SHALL scope every read and every deletion to the authenticated
caller. A request for a workout belonging to another user SHALL be refused with
`404`, indistinguishably from a request for a workout that does not exist, so
that no caller can learn whether another user's workout exists.

A workout id SHALL be rejected with `400` when it is not a well-formed
identifier, before any lookup.

#### Scenario: Another user's workout
- **WHEN** a user requests or deletes a workout owned by somebody else
- **THEN** the request is refused with `404` and the response does not reveal that the workout exists

#### Scenario: A workout that does not exist
- **WHEN** a user requests a workout id that exists nowhere
- **THEN** the request is refused with `404`, identically to another user's workout

#### Scenario: A malformed id
- **WHEN** a request carries an id that is not a well-formed identifier
- **THEN** it is refused with `400`

#### Scenario: Listing is never cross-user
- **WHEN** a user lists their workouts
- **THEN** the page contains only their own workouts, whatever filters were supplied
