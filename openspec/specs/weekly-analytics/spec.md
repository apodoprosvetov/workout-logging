# Weekly Analytics

## Purpose

Answering "how much did I train each muscle group this week?" — the figure a
training log exists to produce. Weekly volume is derived from the workouts a
user has logged and is kept current as they are interpreted, edited and
deleted, so a user never reads a number the system has already superseded.

## Requirements

### Requirement: Report a week's training volume per muscle group

The system SHALL expose `GET /api/analytics/weekly-volume`, accepting an
optional `week` as an ISO week key of the form `YYYY-Www` and answering `200`
with:

```
{ "week": string, "volumes": [ { "muscle_group": string, "volume": number } ] }
```

An absent `week` SHALL mean the current week. A `week` that is not a
well-formed ISO week key, including an out-of-range week number, SHALL be
refused with `400` rather than answered with an empty result.

`volumes` SHALL be ordered by descending volume, so that a client rendering them
in the order received leads with the muscle group trained most.

A week with no training SHALL answer `200` with an empty `volumes`.

#### Scenario: Reading a week
- **WHEN** a user requests the volume for a week in which they trained
- **THEN** the response carries that week's key and its muscle groups with their volumes, ordered from largest to smallest

#### Scenario: The current week by default
- **WHEN** a user requests weekly volume without naming a week
- **THEN** the current ISO week is returned

#### Scenario: A week with no training
- **WHEN** a user requests a week in which they logged nothing
- **THEN** the response is `200` with an empty list of volumes

#### Scenario: A malformed week
- **WHEN** a request names a week that is not a valid ISO week key
- **THEN** it is refused with `400`

### Requirement: Compute volume as weight times repetitions over settled workouts

Volume for a muscle group SHALL be the sum, over every set of that week's
workouts whose exercise is attributed to that muscle group, of the set's weight
multiplied by its repetitions.

An exercise attributed to more than one muscle group SHALL contribute its full
set volume to each of them.

Only settled workouts SHALL be counted — those at `parsed` or `needs_review`. A
workout still being processed or one that failed SHALL contribute nothing, so
that the figures describe exactly the set of workouts the user is shown.

A set whose exercise resolves to no catalog entry SHALL contribute nothing,
because there is no muscle group to attribute it to.

#### Scenario: Volume of a set
- **WHEN** a week contains a single exercise attributed to one muscle group, performed for one set
- **THEN** that muscle group's volume is the set's weight multiplied by its repetitions

#### Scenario: An exercise spanning muscle groups
- **WHEN** a counted exercise is attributed to two muscle groups
- **THEN** each of them receives the full volume of that exercise's sets

#### Scenario: A workout still being processed
- **WHEN** a week contains a workout that has not finished processing
- **THEN** it contributes nothing to that week's volumes

#### Scenario: An unattributed exercise
- **WHEN** a counted workout contains an exercise that resolves to no catalog entry
- **THEN** its sets contribute nothing, while the rest of the workout still counts

### Requirement: Define a week the same way everywhere

A week SHALL be the ISO 8601 week — Monday to Sunday, with week 1 being the week
containing the year's first Thursday — computed in UTC, and SHALL be the half-
open range from its Monday to the next Monday.

Every part of the system that names, bounds or labels a week SHALL use this
definition, so that a workout never appears in two weeks or in none, and so that
the list of a week's workouts and that week's volume figures never disagree
about which workouts the week contains.

#### Scenario: A workout on a boundary
- **WHEN** a workout is performed at the exact start of a week
- **THEN** it belongs to that week and not to the one before it

#### Scenario: The panels agree
- **WHEN** a week's workout list and that week's volume figures are read
- **THEN** both describe the same set of workouts

### Requirement: Keep the figures current as workouts change

The system SHALL recompute a user's weekly volume whenever a workout of theirs
is interpreted, edited or deleted, without the user asking.

Recomputation SHALL cover every week a change touches: the week a deleted
workout belonged to, and for an edit both the week the workout left and the week
it moved to — the week it left taken from what the change carries, since the
stored workout no longer holds the previous date. When both are the same week,
recomputing it once SHALL be enough.

Recomputation SHALL be idempotent: repeated or redelivered recomputation of a
week SHALL leave the same figures as a single one.

Recomputation SHALL be driven by what a change carries rather than by where it
arrived from, since a redelivered change may arrive described as something else.

A recomputed week SHALL be announced to the user's open screens.

#### Scenario: A workout is interpreted
- **WHEN** a workout finishes processing
- **THEN** the volume for its week is recomputed to include it, and the user's open screens are told

#### Scenario: A workout moves between weeks
- **WHEN** an edit moves a workout to a different week
- **THEN** both the week it left and the week it joined are recomputed

#### Scenario: A workout is deleted
- **WHEN** a workout is deleted
- **THEN** its week is recomputed without it, using the date the deletion carried

#### Scenario: Repeated recomputation
- **WHEN** the recomputation of a week is delivered more than once
- **THEN** the resulting figures are the same as after a single delivery

#### Scenario: A change redelivered under another description
- **WHEN** a deletion is redelivered after a failure and arrives described as an interpretation
- **THEN** it is still handled as a deletion and the week is recomputed

### Requirement: Never serve a wrong figure because the cache is cold

The system MAY serve weekly volume from a precomputed cache, and SHALL compute
the same figure directly from the stored workouts when the cache holds nothing
for that week. A caller SHALL NOT be able to tell which happened.

The cached and the directly computed figure SHALL be produced by one shared
definition, so the two cannot drift.

A cache entry SHALL expire after a bounded period of no activity, so that weeks
nobody looks at do not accumulate indefinitely.

#### Scenario: A cold cache
- **WHEN** a week's volume is requested and nothing is cached for it
- **THEN** the response carries the figures computed from the stored workouts, identical to what the cache would have held

#### Scenario: A stale cache after an unannounced deletion
- **WHEN** a deletion's recomputation is lost before it is applied
- **THEN** the cached figure is eventually replaced by a correct one, and no figure is permanently wrong
