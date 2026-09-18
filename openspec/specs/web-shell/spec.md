# Web Shell

## Purpose

How a user moves through the signed-in app: the chrome that is present on every
screen, where the root sends a visitor, what a screen does when there is no
session, and reaching the logging action from anywhere. It is the frame the
dashboard, the history and the editing screens sit inside.

## Requirements

### Requirement: Present the same chrome on every signed-in screen

Every screen of the signed-in app SHALL show the same persistent chrome: the
app's name, navigation between the dashboard and the full workout history, a way
to log a workout, and a way to sign out.

The navigation SHALL indicate which section the user is currently in, including
when they are on a screen nested under that section.

#### Scenario: Chrome on every screen
- **WHEN** a signed-in user moves between the dashboard and the workout history
- **THEN** the same header and navigation are present on both, with the same actions

#### Scenario: The current section
- **WHEN** the user is on the workout history or any screen nested under it
- **THEN** the navigation marks that section as the current one

### Requirement: Offer signed-in actions only to a session

A signed-in action — logging a workout, reaching the in-flight surface, signing
out — SHALL NOT be offered to a visitor without a session, on any screen,
including for the moment a redirect takes.

Whether to offer them SHALL be decided by asking the session directly, not by a
screen remembering to ask for them to be hidden.

A component that reads or subscribes to a user's data SHALL NOT be rendered
without a session at all, rather than rendering and hiding itself, so that a
signed-out screen issues no request that can only be refused.

#### Scenario: On the sign-in screen
- **WHEN** a visitor without a session is on the sign-in or registration screen
- **THEN** no logging action and no sign-out control is offered

#### Scenario: A signed-out visitor on a signed-in route
- **WHEN** a visitor without a session opens a signed-in route and is redirected
- **THEN** no signed-in action is offered while the redirect takes place

#### Scenario: No requests without a session
- **WHEN** a screen is rendered without a session
- **THEN** it issues no request for user data and opens no update channel

### Requirement: Route the root by whether a session exists

The app's root SHALL send a visitor with a valid session to the dashboard and a
visitor without one to the sign-in screen, without briefly displaying the wrong
destination.

The decision SHALL be made from the stored session as it is at that moment, so
that a page refresh does not flash through the sign-in screen before the session
is recognized.

#### Scenario: With a session
- **WHEN** a visitor with a valid session opens the root
- **THEN** they arrive at the dashboard without the sign-in screen appearing first

#### Scenario: Without a session
- **WHEN** a visitor with no session opens the root
- **THEN** they arrive at the sign-in screen

#### Scenario: Refreshing a signed-in screen
- **WHEN** a signed-in user refreshes the page
- **THEN** they stay where they are and are not bounced through the sign-in screen

### Requirement: Keep personal data off a screen with no session

A signed-in screen opened without a valid session SHALL redirect to the sign-in
screen without rendering personal data.

A session ending elsewhere — signed out in another tab, or a session that can no
longer be renewed — SHALL reach an open screen and take it to the sign-in screen
too, rather than leaving it displaying data it can no longer refresh.

#### Scenario: Opening a signed-in screen without a session
- **WHEN** a visitor without a session opens the dashboard directly
- **THEN** they are sent to the sign-in screen and no workout data is rendered

#### Scenario: Signed out in another tab
- **WHEN** the user signs out in another tab
- **THEN** this tab leaves the signed-in screen for the sign-in screen

#### Scenario: The session can no longer be renewed
- **WHEN** an open screen's session can no longer be renewed
- **THEN** the screen is taken to the sign-in screen

### Requirement: Sign out by discarding the session

Signing out SHALL discard the stored session and return the user to the sign-in
screen.

#### Scenario: Signing out
- **WHEN** the user signs out
- **THEN** the stored session is gone, they are on the sign-in screen, and reopening a signed-in screen sends them back to sign-in

### Requirement: Reach logging from anywhere, and dismiss it without cost

The action to log a workout SHALL be reachable from every screen of the signed-in
app, rather than living on one page.

The logging form SHALL be dismissible without submitting, and dismissing it
SHALL discard its unsent contents.

#### Scenario: Logging from the history screen
- **WHEN** a signed-in user is on the workout history
- **THEN** they can open the logging form there without navigating to the dashboard first

#### Scenario: Dismissing the form
- **WHEN** the user dismisses the logging form without submitting
- **THEN** nothing is submitted and what they had typed is discarded

### Requirement: Present a workout the same way in every list

The shared presentation of a workout — its date format, its status label and
styling, and its row layout — SHALL come from one definition, so that the same
workout looks the same wherever it is listed.

A date SHALL be turned into text for a reader in one layer only, so that two
layers cannot each pick a timezone and disagree.

#### Scenario: The same workout in two lists
- **WHEN** a workout appears in the dashboard's weekly list and in the workout history
- **THEN** its date, its status label and its row read identically in both
