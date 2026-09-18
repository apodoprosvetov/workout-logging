# Workout Ingestion

## Purpose

Accepting a workout the moment a user submits it — free text, photographs of a
paper log, or both — and handing it to interpretation without making the user
wait for it. Ingestion decides only that the submission is durably accepted and
whose it is; what the submission *says* is [[workout-extraction]]'s concern.

## Requirements

### Requirement: Accept a workout as text, images, or both

The system SHALL expose `POST /api/workouts`, accepting a multipart body of:

```
text?         string          // free-text description
images?       file[]          // up to MAX_WORKOUT_IMAGES per submission
performed_at? string          // ISO 8601 instant
```

and SHALL answer `202` with `{ "workout_id", "status", "performed_at" }`.

At least one of `text` or `images` SHALL be present; a submission carrying
neither SHALL be refused with `400`. An `images` field that carries nothing
usable — no file, or only empty ones — SHALL be treated as absent rather than as
an image submission.

The system SHALL NOT impose a format or size limit on an individual image. An
image it cannot later interpret is a matter for extraction, not for the
submission.

`performed_at` SHALL be optional. When it is absent the system SHALL store the
moment of submission and SHALL record that the date was not stated, so that
extraction may replace it with a date found in the submission; when it is
present the system SHALL record that the user stated it, and no later step may
overwrite it.

The response SHALL carry the date the workout was stored under, because when the
caller omitted one this is the only way to learn where the workout landed.

#### Scenario: Submitting free text
- **WHEN** a user submits a text description of a workout
- **THEN** the response is `202` and carries the new workout's id, its not-yet-processed status, and the date it was stored under

#### Scenario: Submitting several images
- **WHEN** a user submits a multi-page paper log as several images in one request
- **THEN** all of them are accepted as one workout

#### Scenario: Submitting more images than allowed
- **WHEN** a user submits more images than the per-submission limit
- **THEN** the request is refused with `400` and no workout is created

#### Scenario: Submitting nothing
- **WHEN** a request carries neither text nor any usable image
- **THEN** it is refused with `400`

#### Scenario: Stating the date
- **WHEN** a user submits a workout with an explicit `performed_at`
- **THEN** the workout is stored under that date, and interpretation never moves it

#### Scenario: Leaving the date out
- **WHEN** a user submits a workout with no `performed_at`
- **THEN** the workout is stored under the moment of submission, the response says so, and interpretation may later move it to a date found in the submission

### Requirement: Acknowledge without waiting for interpretation

The system SHALL answer a submission as soon as it is durably stored, at a
not-yet-processed status, and SHALL NOT hold the response until the submission
has been interpreted. The acknowledgement SHALL arrive in under 2 seconds
regardless of how long interpretation takes.

#### Scenario: Acknowledgement is not interpretation
- **WHEN** a user submits a workout whose interpretation will take many seconds
- **THEN** the response arrives in under 2 seconds carrying the not-yet-processed status, and the interpretation continues afterwards

### Requirement: Store the submission and its handoff all-or-nothing

A submission SHALL be either fully accepted or not accepted at all. The system
SHALL NOT leave a workout without its submitted content, stored content without
a workout, or a workout whose handoff to interpretation was never recorded.

The record that interpretation is owed SHALL be committed in the same
transaction as the workout itself, so that a workout cannot exist that nothing
will ever interpret, and a handoff cannot be announced for a workout that was
never committed.

When any part of the write fails, the system SHALL undo what it already wrote,
SHALL refuse the request with `503`, and SHALL state that nothing was saved —
`503` rather than `500` because the request was well formed and repeating it is
the right thing to do.

#### Scenario: A datastore is unreachable
- **WHEN** a submission cannot be written because a datastore cannot be reached
- **THEN** the request is refused with `503`, the response says nothing was saved, and no workout, stored image or partial record remains

#### Scenario: Failure after the images were stored
- **WHEN** the images are stored but the workout cannot be committed
- **THEN** the stored images and the stored submission are removed, and the caller is told nothing was saved

#### Scenario: The handoff survives the accepting process
- **WHEN** a submission is committed and the process handling the request stops immediately afterwards
- **THEN** the workout is still interpreted once the system recovers, without the user resubmitting

### Requirement: Rate-limit submissions per user

The system SHALL allow at most 30 submissions per minute per user and SHALL
refuse further submissions with `429` until the window allows them again.

The limit SHALL be counted per user rather than per connection or per replica,
so that it holds however the request is routed. It SHALL apply only after the
caller has been authenticated, so that an unauthenticated request is refused as
unauthenticated rather than as rate-limited.

#### Scenario: Within the limit
- **WHEN** a user submits fewer workouts than the limit within a minute
- **THEN** every submission is accepted

#### Scenario: Over the limit
- **WHEN** a user exceeds the limit within a minute
- **THEN** further submissions are refused with `429` until the window allows them again, and no workout is created for a refused submission

#### Scenario: One user's limit does not affect another
- **WHEN** one user is being rate-limited
- **THEN** another user's submissions are unaffected

### Requirement: A submission belongs to the user who made it

The system SHALL record every submission against the authenticated caller, taken
from their token. A submission SHALL NOT be attributable to another user by
anything the caller sends.

#### Scenario: Ownership comes from the token
- **WHEN** a user submits a workout
- **THEN** the workout belongs to that user, and no field in the request can change whose it is

### Requirement: Announce a newly created workout

The system SHALL announce a committed submission to the user's open screens, so
that a screen other than the one that submitted it reflects the new workout
without the user reloading. The announcement SHALL identify the workout and the
date it was stored under.

Announcing SHALL happen outside the boundary that makes the write all-or-nothing
and SHALL NOT be able to fail the submission: a workout that is committed stays
committed even when nothing can be announced.

#### Scenario: A second screen sees the submission
- **WHEN** a user submits a workout on one device while another device has the app open
- **THEN** the other device learns of the new workout without the user reloading

#### Scenario: Announcement fails
- **WHEN** a submission is committed but the announcement cannot be delivered
- **THEN** the submission still succeeds and the workout remains stored
