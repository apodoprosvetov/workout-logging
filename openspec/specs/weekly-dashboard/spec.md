# Weekly Dashboard

## Purpose

Showing one training week at a time — the week's volume per muscle group beside
the workouts performed in it — because training is planned and reviewed in
weekly cycles, and an all-time total answers no useful question.

The figures themselves are [[weekly-analytics]]'s; this capability is how a user
moves through weeks and what the screen must show while doing it.

## Requirements

### Requirement: Show exactly one week, labelled by its dates

The dashboard SHALL present exactly one training week at a time and SHALL label
it with that week's calendar date range.

Every panel on the dashboard SHALL describe the same selected week. No panel may
show all-time or otherwise unscoped data.

A week SHALL include every workout performed on any of its seven days and
exclude every workout outside them, using the same week definition the rest of
the system uses, so that a user near midnight or in another timezone never sees
one workout in two weeks.

#### Scenario: Opening the dashboard
- **WHEN** a user opens the dashboard
- **THEN** it shows the current week, labelled with that week's date range, and every panel describes that week

#### Scenario: Panels agree
- **WHEN** the dashboard shows a week in which the user trained
- **THEN** the volume figures and the listed workouts describe the same set of workouts

### Requirement: Step between weeks within a bounded window

The user SHALL be able to step to the previous week and back toward the present,
one week per step.

The dashboard SHALL NOT offer a week later than the current one, nor earlier
than a fixed number of weeks in the past. A control that would leave the window
SHALL be unavailable rather than doing nothing when used.

#### Scenario: Stepping back
- **WHEN** the user steps to the previous week
- **THEN** every panel describes that week and the label shows its dates

#### Scenario: At the present
- **WHEN** the current week is shown
- **THEN** the control for a later week is unavailable

#### Scenario: At the edge of the window
- **WHEN** the earliest week the dashboard offers is shown
- **THEN** the control for an earlier week is unavailable

### Requirement: Show a week's workouts in full

The week's workout list SHALL show every workout in that week without silently
truncating.

It SHALL request the week directly as a date window rather than fetching
unscoped data and filtering it afterwards.

#### Scenario: A busy week
- **WHEN** a week contains more workouts than a default page would hold
- **THEN** all of them are shown, with nothing silently dropped

### Requirement: Distinguish loading, empty and failed in every panel

Each panel SHALL distinguish three states — loading, empty, and failed — and a
failed panel SHALL offer a retry that preserves the selected week.

An empty week SHALL be stated as such rather than shown as a blank area.

#### Scenario: A week with no training
- **WHEN** the selected week contains no workouts
- **THEN** the panels say so rather than showing nothing

#### Scenario: A panel fails to load
- **WHEN** a panel cannot load its data
- **THEN** it says so and offers a retry, and retrying reloads the same week rather than resetting to the current one

### Requirement: Follow a workout this session logged to its week

When a workout logged in this session settles into a week other than the one on
screen, the dashboard SHALL move to that workout's week, so the entry is visible
without further action.

This SHALL apply only to the session that logged the workout, only when it
settled to a status that places it in the settled lists, and only when the
target week differs from the one shown. A workout logged on another device SHALL
NOT move this screen.

The move SHALL be driven by the date the workout carries once it has settled,
not the date it was submitted with — interpretation may have moved it.

A target week outside the dashboard's window SHALL be clamped to the nearest
week the dashboard offers rather than ignored, so that the user still sees that
something happened.

#### Scenario: A workout settles into another week
- **WHEN** the session that logged a workout learns it settled into a different week
- **THEN** the dashboard moves to that week

#### Scenario: A workout logged elsewhere
- **WHEN** a workout logged on another device settles
- **THEN** this dashboard stays on the week it is showing

#### Scenario: A failed workout
- **WHEN** a workout logged in this session settles as failed
- **THEN** the dashboard does not move, because the workout stays in the in-flight surface

#### Scenario: Outside the window
- **WHEN** the workout's week is older than the dashboard's window allows
- **THEN** the dashboard moves as far back as it offers rather than staying put
