# In-Flight Workouts

## Purpose

Giving a workout that is still being processed, or that failed, somewhere of its
own to live — so the ordinary lists and the weekly figures describe exactly the
same settled workouts, and so work in progress is never invisible.

This exists because an unsettled workout cannot sit safely in a week-scoped
list: interpretation may move its date, so a row displayed inside a week can
leave that week with the user doing nothing, forcing a choice between silently
removing it and navigating the user away from what they were reading.

## Requirements

### Requirement: A workout is in exactly one place at a time

The settled lists — the dashboard's weekly list and the workout history — SHALL
show only workouts that have finished processing, whether fully or with items
needing review. A workout still being processed and one that failed SHALL NOT
appear there.

The in-flight surface SHALL list exactly those workouts of the user's that are
being processed or have failed.

A workout SHALL be in exactly one of the two at any moment, and SHALL move from
the in-flight surface to the settled lists at the moment it settles, without the
user acting.

#### Scenario: A workout is logged
- **WHEN** a user logs a workout
- **THEN** it appears in the in-flight surface and in neither the dashboard's weekly list nor the history

#### Scenario: A workout settles
- **WHEN** a workout finishes processing
- **THEN** it leaves the in-flight surface and appears in the settled lists, without the user acting

#### Scenario: A workout fails
- **WHEN** a workout's processing fails
- **THEN** it stays in the in-flight surface and never appears in the settled lists

### Requirement: Reach the in-flight surface wherever a workout can be logged

The in-flight surface SHALL be reachable from every screen that offers the
logging action.

While it is closed, the control that opens it SHALL show how many of the user's
workouts are in flight, so that work in progress and failures are never
invisible.

#### Scenario: Reaching it
- **WHEN** a signed-in user is on any screen offering the logging action
- **THEN** the in-flight surface can be opened from there

#### Scenario: The count while closed
- **WHEN** the user has workouts being processed or failed and the surface is closed
- **THEN** the control that opens it shows how many there are

#### Scenario: Nothing in flight
- **WHEN** no workout of the user's is being processed or failed
- **THEN** the control shows no count

### Requirement: A failed workout stays until the user dismisses it

A failed workout SHALL remain in the in-flight surface, described in terms the
user can act on, until the user dismisses it. Dismissing SHALL discard the
workout.

The system SHALL NOT dismiss a failure on the user's behalf, and SHALL NOT move
the user away from the surface showing it.

#### Scenario: A failure is shown
- **WHEN** a workout fails
- **THEN** it stays listed with an explanation the user can act on until they dismiss it

#### Scenario: Dismissing
- **WHEN** the user dismisses a failed workout
- **THEN** the workout is discarded and it is gone from the surface

#### Scenario: Dismissal fails
- **WHEN** discarding a dismissed workout does not succeed
- **THEN** the workout is restored to the surface rather than disappearing from a screen while still existing

### Requirement: State plainly when nothing is in progress

The in-flight surface SHALL state plainly when nothing is being processed and
nothing has failed, rather than showing an empty area the user has to interpret.

It SHALL distinguish loading, empty and failed-to-load from one another.

#### Scenario: Empty
- **WHEN** the surface is opened with nothing in flight
- **THEN** it says so in words

#### Scenario: Could not be read
- **WHEN** the surface cannot read the user's in-flight workouts
- **THEN** it says the list could not be loaded and offers to try again, distinctly from saying nothing is in flight

### Requirement: Show the true state whether or not updates are arriving

The in-flight surface SHALL read the user's current in-flight workouts when it
is opened, rather than relying on announcements having been received.

It SHALL also update itself from announcements while it is open.

When a newer read has been started, the surface SHALL NOT let an older one that
finishes later replace its contents.

#### Scenario: Opened with no update channel
- **WHEN** the surface is opened while updates are not arriving
- **THEN** it shows the user's true current in-flight workouts

#### Scenario: Something settles while it is open
- **WHEN** a listed workout settles while the surface is open
- **THEN** it leaves the list without the user closing and reopening it

#### Scenario: Overlapping reads
- **WHEN** a second read is started before the first returns
- **THEN** the later read's result is what the surface shows
