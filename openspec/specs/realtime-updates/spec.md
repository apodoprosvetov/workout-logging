# Realtime Updates

## Purpose

Telling a screen that something it is displaying has changed, so the user is not
left guessing when to reload. Logging a workout is asynchronous — it is accepted
at once and interpreted later — and without this channel an open screen shows a
placeholder row and superseded volume figures indefinitely.

The channel carries announcements, never the data itself: every announcement
names what changed precisely enough for a screen to decide whether it cares, and
the screen then reads the current truth through the ordinary read paths.

## Requirements

### Requirement: Expose an update channel to a signed-in session

The system SHALL expose `GET /api/events` as a server-sent event stream carrying
the authenticated caller's change notifications.

Establishing a channel SHALL require a valid access token. The system SHALL stop
delivering to a channel once the session behind it is no longer valid, rather
than serving a session that has outlived its credentials.

The system SHALL send a keep-alive frame when the stream opens and at a fixed
interval while it is otherwise idle. The opening frame matters: a client earns
"connected" from a received frame rather than from an open socket, and without
it a freshly opened stream says nothing for a whole interval.

#### Scenario: Opening a channel
- **WHEN** a signed-in client opens the update channel
- **THEN** the stream is established and a keep-alive frame arrives immediately, without waiting for the first interval

#### Scenario: No credentials
- **WHEN** a client opens the update channel without a valid access token
- **THEN** the request is refused with `401` and no stream is established

#### Scenario: The session outlives its token
- **WHEN** an open channel's access token reaches its expiry
- **THEN** the system stops delivering on that channel and the client re-establishes it with a valid token

#### Scenario: An idle channel
- **WHEN** a channel stays open with nothing to announce
- **THEN** keep-alive frames continue at the fixed interval and the channel is not silently closed as idle

### Requirement: Announce every change to the data a screen may be showing

The system SHALL announce to a user's open screens when a workout of theirs
changes processing status, is created, is edited, or is deleted, and when the
training-volume figures for one of their weeks have been recomputed.

Every announcement SHALL carry the kind of change, an identifier for the
occurrence, the owning user and when it occurred, in the body itself — the kind
SHALL NOT be inferable only from where the announcement arrived, because a
redelivered change can arrive described as something else.

An announcement SHALL identify what changed precisely enough for a screen to
decide whether it is displaying the affected data *without fetching anything
first*: which workout, which week's figures, and for a workout the date it now
carries.

An announcement about an edit SHALL NOT carry a date. An edit can move a workout
between weeks, and a week-scoped screen drops an announcement whose week is not
the one on screen — a dashboard showing the week the workout *left* would
otherwise keep listing it. Carrying no date means "may concern any week".

#### Scenario: A workout settles
- **WHEN** a workout of the user's finishes processing
- **THEN** their open screens receive an announcement naming the workout, the status it settled at and the date it carries

#### Scenario: Volume recomputed
- **WHEN** a week's volume figures are recomputed
- **THEN** the announcement names the ISO week that changed

#### Scenario: An edit
- **WHEN** a workout is edited
- **THEN** the announcement names the workout and carries no date, so that every week-scoped screen treats it as possibly concerning the week it shows

#### Scenario: A redelivered change
- **WHEN** an announcement is redelivered after a failure and its transport describes it as another kind
- **THEN** it is handled as the kind its body states

### Requirement: Deliver only a user's own changes, to all of their sessions

The system SHALL deliver a user's announcements to every session authenticated
as that user, not only the one that caused the change.

A user SHALL NOT receive any announcement about another user's data, including
its existence. The routing itself SHALL be per user, so that a cross-user leak
would require addressing the wrong user rather than missing a filter.

Delivery SHALL work however a session's connection is routed, including when a
user's sessions are held by different replicas and the change occurred on
neither of them.

#### Scenario: Two devices
- **WHEN** a user has the app open on two devices and logs a workout on one
- **THEN** both receive the announcement

#### Scenario: Another user's change
- **WHEN** another user's workout settles
- **THEN** nothing about it reaches this user's channels

#### Scenario: A change from elsewhere
- **WHEN** a change is produced by a process other than the one holding the user's connection
- **THEN** the announcement still reaches that connection

### Requirement: An announcement is never the only copy of what it describes

The data an announcement concerns SHALL remain retrievable through the ordinary
read paths, so a screen can obtain the current state independently of what any
announcement carried, and a screen that missed one is never permanently wrong.

The system SHALL NOT retain undelivered announcements for a session that is gone
or not consuming them. An announcement with no listener SHALL be dropped.

#### Scenario: An announcement with no listener
- **WHEN** a change is announced while the user has no open channel
- **THEN** it is dropped rather than accumulated, and the change is still visible through an ordinary read

#### Scenario: Recovering without the announcement
- **WHEN** a screen never receives an announcement about a change it displays
- **THEN** reloading or re-reading shows the current state

### Requirement: Cap the channels one user can hold

The system SHALL limit how many concurrent channels a single user may hold, so
that one user cannot exhaust capacity for others, and SHALL refuse a channel
beyond that limit with `429`.

The check and the grant SHALL be one operation; split into counting and then
adding, the limit would quietly stop holding.

A failure to establish the notification backing SHALL be refused with `503`,
distinctly from the cap — the two mean different things to a client: too many of
your own connections, versus this service cannot deliver right now.

#### Scenario: At the cap
- **WHEN** a user opens more channels than the limit allows
- **THEN** the additional attempt is refused with `429` and the existing channels are unaffected

#### Scenario: Notification backing unavailable
- **WHEN** a channel is requested and the notification backing cannot be reached
- **THEN** the request is refused with `503`, distinctly from the cap refusal

#### Scenario: A closed channel frees its slot
- **WHEN** a user at the cap closes a channel
- **THEN** a new channel can be opened

### Requirement: Bring a screen up to date without disturbing the user

On learning that data it is displaying has changed, a screen SHALL bring itself
up to date without user action, and SHALL ignore announcements about data it is
not currently displaying.

Updating SHALL preserve what the user has chosen — the week the dashboard is on,
the page of history being read, and the scroll position — and SHALL NOT discard
input in progress, a partially filled logging form in particular.

An update SHALL NOT navigate the user. The single exception is the session that
logged a workout, which MAY move the dashboard to the week that workout settled
into; no other session may change week in response to it.

Repeated and concurrent announcements SHALL leave a screen in the same state as
the last change alone would have: applying one more than once, or out of order,
SHALL be safe.

#### Scenario: A settled workout on the week being shown
- **WHEN** a workout settles into the week the dashboard is displaying
- **THEN** the dashboard reflects it without the user acting, and stays on that week

#### Scenario: A change to another week
- **WHEN** a change concerns a week the screen is not displaying
- **THEN** the screen ignores it

#### Scenario: The logging session follows its workout
- **WHEN** the session that logged a workout learns it settled into a different week than the one on screen
- **THEN** that session moves to the workout's week, and the user's other sessions stay where they are

#### Scenario: A form is open
- **WHEN** an announcement arrives while the user is filling in the logging form
- **THEN** what they have typed is preserved

#### Scenario: The same change twice
- **WHEN** an announcement is delivered repeatedly, or two arrive out of order
- **THEN** the screen ends in the state the last change alone would have produced

### Requirement: Recover from a dropped channel on its own

A client SHALL re-establish a dropped channel without the user reloading, and
SHALL wait longer between successive failures rather than retrying in a tight
loop. Successive delays SHALL grow to a ceiling, and SHALL be spread so that
many clients dropped at once do not return in step — spreading SHALL keep a
floor under the delay, so randomization cannot reproduce the tight loop.

A client SHALL give up retrying only after a bounded period, not after a fixed
number of attempts, since a refused connection fails in milliseconds while a
hanging one takes tens of seconds.

After a channel is re-established, the screen SHALL reflect changes that
occurred while it was down.

#### Scenario: The connection drops
- **WHEN** an open channel is dropped
- **THEN** the client re-establishes it without the user reloading

#### Scenario: Repeated failures
- **WHEN** re-establishing keeps failing
- **THEN** the wait between attempts grows to a ceiling and never collapses into a tight loop

#### Scenario: Changes during an outage
- **WHEN** a workout settles while the channel is down
- **THEN** once the channel is back the screen reflects it, and the workout has left the in-flight surface

### Requirement: Say when updates are not arriving, and keep working without them

A client SHALL distinguish "receiving updates" from "not receiving updates", and
SHALL derive it from frames actually received rather than from a socket
appearing open — an intermediary can cut a stream and leave a socket that looks
open indefinitely. A client SHALL treat silence longer than the keep-alive
interval allows as not receiving updates.

A client SHALL NOT present data as live while updates are not arriving, and
SHALL NOT present the absence of the channel as an error or block the interface
with it. Real-time delivery is an enhancement.

With no channel at all, every screen SHALL remain fully usable and SHALL still
show correct data on load, navigation and reload, and the in-flight surface
SHALL still show the true current state when opened.

#### Scenario: The channel goes quiet
- **WHEN** no frame arrives for longer than the keep-alive interval allows
- **THEN** the client stops reporting itself as receiving updates and says so without presenting an error

#### Scenario: Freshly loaded
- **WHEN** a screen has just loaded its data and the channel is still being established
- **THEN** nothing is announced to the user, because what is on screen was just read and is current

#### Scenario: The channel cannot be established at all
- **WHEN** the update channel never establishes
- **THEN** every screen still loads, navigates, reloads and shows correct data, and the in-flight surface still shows the true state when opened

### Requirement: Delivery never compromises the change it describes

Announcing a change SHALL NOT be able to fail the change: a workout that is
stored, interpreted, edited or deleted SHALL remain so even when nothing can be
announced.

The system SHALL record enough about channel lifecycle and delivery —
connections opened and closed, announcements published and dropped — to
diagnose, after the fact, a report that a screen did not update.

A failure of the notification backing SHALL NOT take down the API.

#### Scenario: Announcement fails after a change commits
- **WHEN** a change is committed and the announcement cannot be delivered
- **THEN** the change stands and the request that produced it still succeeds

#### Scenario: The notification backing fails while the API runs
- **WHEN** the notification backing becomes unavailable
- **THEN** the API keeps serving its ordinary read and write paths
