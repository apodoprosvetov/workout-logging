# Workout Extraction

## Purpose

Turning what a user submitted — free text, photographs, or both — into the
structured workout the rest of the system reads: exercises in order, each with
its sets, and each set's weight, reps and unit. Extraction runs after the
submission has been accepted ([[workout-ingestion]]) and is the only thing that
moves a workout out of its not-yet-processed state.

## Requirements

### Requirement: Interpret a submission into a structured workout

The system SHALL interpret an accepted submission into an ordered list of
exercises, each carrying an ordered list of sets with a weight, a repetition
count and a unit of `kg` or `lb`. Order SHALL be taken from the submission and
preserved.

Text and images belonging to one submission SHALL be interpreted together as one
workout, not as one workout per image.

The system SHALL take a workout's name from the submission when it states one,
as written, and SHALL NOT invent a name from the exercises it found.

When the submission states a date and the user did not, the system SHALL move
the workout to that date. When the user stated a date at submission, the system
SHALL leave it alone.

#### Scenario: A text submission
- **WHEN** a submission describes several exercises with their sets in free text
- **THEN** the workout carries those exercises in the submitted order, each with its sets, weights, repetitions and units

#### Scenario: A multi-image submission
- **WHEN** a submission carries several photographs of one training session
- **THEN** one workout is produced from all of them together

#### Scenario: A date written in the submission
- **WHEN** the user did not state a date and the submission itself names one
- **THEN** the workout moves to the date named in the submission

#### Scenario: The user stated the date
- **WHEN** the user stated a date at submission and the submission text names a different one
- **THEN** the workout keeps the date the user stated

### Requirement: Attribute every extracted exercise to the catalog

The system SHALL resolve each extracted exercise name against the exercise
catalog, tolerating spellings the catalog records as alternates, so that a
workout's sets can be attributed to muscle groups.

When a name does not resolve, the system SHALL still record the exercise and its
sets rather than discarding them, and SHALL mark the workout as needing review.
The sets of an unresolved exercise contribute nothing to weekly volume, because
there is no muscle group to attribute them to.

#### Scenario: A known exercise
- **WHEN** an extracted name matches a catalog entry, including by one of its recorded alternate spellings
- **THEN** the exercise is attributed to that entry and its sets count toward that entry's muscle groups

#### Scenario: An unknown exercise
- **WHEN** an extracted name resolves to no catalog entry
- **THEN** the exercise and its sets are still recorded, the workout is marked as needing review, and those sets contribute nothing to weekly volume

### Requirement: Settle every workout at a status that says what happened

The system SHALL leave every workout it processes at exactly one settled status:

- `parsed` — content was extracted and every exercise resolved to the catalog.
- `needs_review` — the workout was stored, but nothing was extracted from it, or
  at least one exercise did not resolve.
- `failed` — the submission could not be processed at all and retrying will not
  change that.

The system SHALL NOT discard a submission it could not interpret and SHALL NOT
present it as successfully interpreted. A workout SHALL NOT remain
not-yet-processed once processing has concluded.

#### Scenario: A clean extraction
- **WHEN** every exercise in a submission is extracted and resolves to the catalog
- **THEN** the workout settles as `parsed`

#### Scenario: Nothing recognizable in the submission
- **WHEN** no exercise can be extracted from a submission
- **THEN** the workout settles as `needs_review` rather than being discarded or shown as parsed

#### Scenario: Nothing to process
- **WHEN** the submitted content cannot be found or read at all, and retrying cannot change that
- **THEN** the workout settles as `failed` and is not retried

### Requirement: Retry what may succeed and give up on what cannot

The system SHALL retry a failure that may be transient — an unreachable
interpretation service, a datastore that is momentarily unavailable — with
increasing delays between attempts, and SHALL stop after a bounded number of
attempts rather than retrying indefinitely.

A failure that retrying cannot fix SHALL NOT be retried: the system SHALL settle
the workout as `failed` immediately.

Work that has exhausted its retries SHALL be preserved for inspection rather
than discarded silently.

#### Scenario: A transient failure
- **WHEN** interpretation fails because a dependency is momentarily unavailable
- **THEN** it is retried after a delay, and the delays grow between attempts

#### Scenario: Retries exhausted
- **WHEN** interpretation keeps failing past the last retry
- **THEN** it stops being retried and the attempt is preserved for inspection

#### Scenario: A failure retrying cannot fix
- **WHEN** the submission's stored content no longer exists
- **THEN** the workout settles as `failed` without consuming retry attempts

### Requirement: Never produce a workout twice from one submission

Reprocessing the same submission SHALL NOT produce a second workout, duplicate
exercises or duplicate sets, however many times it is delivered.

The system SHALL apply extraction results only to a workout that is still
not-yet-processed, so that a redelivery arriving after the workout has settled
changes nothing.

A redelivery that changes nothing SHALL NOT announce anything either, so that a
screen does not see a workout settle twice.

#### Scenario: The same submission delivered twice
- **WHEN** an accepted submission is handed to extraction more than once
- **THEN** exactly one workout exists with one copy of its exercises and sets

#### Scenario: A redelivery after settling
- **WHEN** a submission is redelivered after its workout has already settled
- **THEN** the workout is left as it is and nothing is announced again

### Requirement: Discard submitted images once the workout settles

The system SHALL delete a submission's stored images once its workout reaches a
settled status. Images are transient input, not retained data.

The structured workout and the interpretation service's raw response SHALL be
retained.

A failure to delete images SHALL NOT fail or retry a workout that has already
settled successfully.

#### Scenario: Images are discarded after settling
- **WHEN** a workout that carried images settles
- **THEN** the stored image bytes are deleted, and the structured workout and the raw response remain

#### Scenario: Cleanup fails
- **WHEN** the images cannot be deleted after the workout has settled
- **THEN** the workout stays settled and is not reprocessed

### Requirement: Announce that a workout has settled

The system SHALL announce each settling to the user's open screens, identifying
the workout, the status it settled at, and the date it now carries — the date is
required because extraction may have moved it, and a screen must be able to tell
which week the change concerns.

The announcement SHALL carry only a settled status; a not-yet-processed workout
has nothing to announce.

The announcement SHALL be its own occurrence, timestamped when the settling
happened rather than when the submission was made.

Announcement SHALL NOT be able to fail the extraction: a workout that has been
interpreted and committed stays that way even if nothing can be announced.

#### Scenario: A workout settles
- **WHEN** a workout finishes processing
- **THEN** the user's open screens are told which workout settled, at what status, and under what date

#### Scenario: A workout that failed
- **WHEN** a workout settles as `failed`
- **THEN** that too is announced, carrying the date the workout holds

#### Scenario: Announcement fails
- **WHEN** a workout settles but the announcement cannot be delivered
- **THEN** the workout remains settled and is not reprocessed
