# Feature Specification: Real-Time Updates

**Feature Branch**: `004-realtime-updates`

**Created**: 2026-09-09

**Status**: Draft

**Input**: User description: "Треба розробити real time communication між backend та frontend, основна ідея це отримувати апдейти від воркерів. Коли workout створився або коли оновилася аналітика, щоб фронт знав коли забрати нові данні. запропонуй технології і патерни для реалізації"

## Context

Logging a workout is asynchronous by design. The user submits a workout, the
system accepts it immediately at a not-yet-processed status, and background
processing later resolves it — extracting the exercises, and recomputing the
affected week's training volume.

Today the screen the user is looking at learns none of that. Spec 003 made a
newly logged workout appear right away, but explicitly deferred its later
transition: FR-013 there states the system "is NOT required to reflect a
workout's later change of processing status on an already-open screen; that
transition may require a reload". Its Clarifications section names the missing
piece directly — "a server-to-client update channel" — and says it "is a feature
in its own right and belongs in its own spec". This is that spec.

The user-visible consequence today: after logging, the user stares at a
placeholder row and has to guess when to reload. If they reload too early they
see nothing new; if they never reload, the dashboard's volume chart keeps
showing figures that the system has already superseded. The same gap makes two
open tabs, or a phone and a laptop, disagree indefinitely.

The scope here is the channel and the screen behaviour it enables: the system
telling an open screen that something it is displaying has changed, so the
screen can show the current truth on its own.

### Where an unprocessed workout belongs

This feature also settles a question the current design left ambiguous: *where*
a workout lives while it is still being processed.

Today an unprocessed workout sits in the ordinary workout lists, and this
already produces a visible contradiction on the dashboard — the weekly list
counts a not-yet-processed workout as part of the week, while the volume chart
beside it does not. The two panels describe the same week differently.

It also creates a harder problem once updates become live. Background
processing may move a workout's date: when the user did not state a date, the
parser adopts one it finds in the submitted text. A workout that is displayed
inside a week can therefore leave that week without the user doing anything —
forcing a choice between silently removing a row and navigating the user away
from the week they were reading. Both are bad, and neither is necessary.

So the lists and the dashboard show only **settled** workouts — those whose
processing has finished, successfully or with items needing review. Workouts
still being processed, and those that failed, live in a dedicated in-flight
surface reachable from the same place the user logs a workout. A workout enters
the ordinary lists at the moment it settles, and never moves between weeks while
on display.

This is what makes the rest of the feature coherent: an unsettled workout is
never shown inside a week, so a date discovered during processing can never
disturb a week the user is reading.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Watching a logged workout land (Priority: P1)

A user logs a workout. It appears immediately in the in-flight surface, shown as
still being processed, so they can see the system has it. They can close that
surface and carry on. When processing finishes, the workout leaves the in-flight
surface on its own and appears among their settled workouts, with the exercises
and sets that were extracted from what they submitted.

**Why this priority**: This is the gap that makes the product feel broken. It is
the one moment where the user is actively waiting for the system, and today the
system gives them nothing to wait on. Delivered alone, it removes the only
mandatory page reload in the core flow and is a complete, demonstrable
improvement.

**Independent Test**: Log a workout and do nothing else. Without any user action
— no reload, no navigation, no click — it must move out of the in-flight surface
and become visible among the settled workouts with its extracted exercise
detail.

**Acceptance Scenarios**:

1. **Given** a user has just logged a workout, **When** they look at the
   in-flight surface, **Then** that workout is listed there as still being
   processed, and it is absent from the dashboard and the workout history.
2. **Given** a workout is listed as processing in the in-flight surface, **When**
   background processing finishes successfully, **Then** it disappears from that
   surface and appears in the workout history and in its week on the dashboard,
   without the user reloading or navigating.
3. **Given** the user is watching the in-flight surface after logging a workout,
   **When** that workout settles into a week other than the one the dashboard is
   showing, **Then** the dashboard moves to the week it landed in, so the user
   can see where it went.
4. **Given** a workout settles to a state needing review, **When** it leaves the
   in-flight surface, **Then** it appears among the settled workouts marked as
   needing review, not as fully processed.
5. **Given** a workout is being processed, **When** processing fails
   permanently, **Then** it remains in the in-flight surface marked as failed,
   with an explanation, rather than disappearing or staying "processing" forever.
6. **Given** a failed workout is in the in-flight surface, **When** the user
   dismisses it, **Then** it is discarded and the surface stops reporting it.
7. **Given** the user has closed the in-flight surface, **When** workouts of
   theirs are still being processed, **Then** the control that opens the surface
   shows how many, so the work is never invisible.
8. **Given** a workout settles, **When** the user was scrolled down or had an
   entry expanded, **Then** their scroll position and expanded entry are
   preserved.

---

### User Story 2 - Weekly analytics stay current on an open dashboard (Priority: P2)

A user has the dashboard open. When the system finishes recalculating the
training volume for a week they are looking at — because a workout in that week
was processed, or deleted — the volume figures on screen change to match, with
no reload.

**Why this priority**: Analytics are the reason the dashboard exists, and a
number that silently disagrees with reality is worse than a number that is
visibly loading. This depends on the same channel as P1 but is a separate slice:
the volume figures are recomputed independently of any single workout's status,
and can change without any entry in the visible list changing.

**Independent Test**: Open the dashboard on a given week, cause that week's
volume to be recomputed, and confirm the displayed figures change to the new
values without user action, while the dashboard stays on the week it was showing.

**Acceptance Scenarios**:

1. **Given** the dashboard is open on the current week, **When** a workout in
   that week finishes processing and the week's volume is recomputed, **Then**
   the displayed volume figures update to the recomputed values without a
   reload.
2. **Given** the dashboard is open on a past week, **When** the volume for a
   *different* week is recomputed, **Then** the displayed figures do not change
   and the dashboard does not switch weeks.
3. **Given** the dashboard is open, **When** a workout is deleted and its week's
   volume is recomputed, **Then** the displayed figures drop to exclude it
   without a reload.
4. **Given** analytics for the displayed week are recomputed, **When** the
   update arrives, **Then** the dashboard remains on the week the user was
   viewing — an update must never navigate the user away from what they chose to
   look at.

---

### User Story 3 - Every open session of the same user agrees (Priority: P3)

A user has the app open in more than one place — a second browser tab, or a
phone alongside a laptop. A change made in one place, or produced by background
processing, becomes visible in all of them.

**Why this priority**: Valuable and a natural consequence of pushing changes
from the server rather than from the tab that made them, but the single-screen
experience in P1 and P2 is what users hit every session. This story is what
distinguishes a real server-to-client channel from a local in-page signal, and
it is where the current in-page-only mechanism visibly falls short.

**Independent Test**: Open the app in two separate sessions for the same user.
Perform a change in one — log a workout, delete a workout — and confirm the
other reflects it without being touched.

**Acceptance Scenarios**:

1. **Given** the same user has the workout history open in two tabs, **When**
   they delete a workout in one tab, **Then** it disappears from the other tab
   without a reload.
2. **Given** the same user has the app open on two devices, **When** a workout
   logged on one finishes processing, **Then** both devices show it among the
   settled workouts.
3. **Given** a workout logged on one device settles into a week that a *second*
   device is not showing, **When** the update arrives, **Then** the second device
   does not change week — only the session that logged the workout may follow it.
4. **Given** the same user has the app open in two tabs, **When** a workout of
   theirs is being processed, **Then** both tabs report it as in flight.
5. **Given** two different users each have the app open, **When** one user's
   workout is processed, **Then** the other user's screen shows no change and
   receives nothing about it.

---

### User Story 4 - Interruptions do not leave stale data on screen (Priority: P3)

A user's connection drops, their laptop sleeps, or they leave a tab in the
background for an hour. When they come back, the screen shows current data
rather than a snapshot frozen at the moment the connection died.

**Why this priority**: Without this, the feature actively makes things worse: a
screen that has been silently updating trains the user to trust it, so a dead
channel that stops updating is now a lie rather than a known limitation. This is
what makes the other three stories dependable, but each of them is demonstrable
before it exists.

**Independent Test**: Open a screen, sever connectivity, cause changes on the
server, restore connectivity, and confirm the screen returns to showing current
data without user action.

**Acceptance Scenarios**:

1. **Given** an open screen whose update channel has dropped, **When**
   connectivity returns, **Then** the channel is re-established automatically
   and the screen shows current data, without the user reloading.
2. **Given** changes occurred while the channel was down, **When** it is
   re-established, **Then** those changes are reflected on screen — a change
   that happened during the outage must not be permanently invisible.
3. **Given** an open screen left untouched for an extended idle period, **When**
   a change occurs, **Then** it still reaches the screen — the channel must not
   die silently from inactivity.
4. **Given** the update channel cannot be established at all, **When** the user
   uses the app, **Then** every screen still loads and shows correct data on
   navigation and reload, and no error blocks any primary flow.
5. **Given** a user signs out, **When** the session ends, **Then** the update
   channel is closed and no further updates are delivered to that screen.

---

### Edge Cases

- **Rapid succession**: several workouts are logged and processed within a few
  seconds. Every affected screen must settle on the correct final state, not a
  state produced by updates arriving out of order.
- **Update arrives mid-request**: a change is pushed while the screen already
  has a fetch in flight for the same data. The older response must not overwrite
  the newer one. (The existing screens already guard against out-of-order
  responses; this feature must not defeat that.)
- **Update for data not on screen**: a workout settles into a week the dashboard
  is not showing, or onto a page of history the user has not scrolled to. The
  screen must not be disrupted and must not silently jump.
- **Deleted while processing**: a workout is deleted or dismissed before its
  processing finishes. The screen must not resurrect it when the processing
  update arrives, and the in-flight surface must not keep reporting it.
- **Processing outlives the session**: a workout is still in flight when the user
  signs out or closes the app. On returning, the in-flight surface must reflect
  its true current state — settled and in the lists, or still processing, or
  failed — never a stale copy of what was in flight last time.
- **Date discovered during processing**: processing assigns the workout a date in
  a different week from the one implied at logging. Because it was never
  displayed inside a week, no week on screen may change as a result — except the
  logging session following it, per the story above.
- **Nothing in flight**: the user has no workouts being processed. The in-flight
  surface must be reachable and state plainly that there is nothing in progress,
  rather than appearing broken or empty without explanation.
- **Expired session**: the user's credentials expire while the channel is open.
  The channel must re-authenticate or close cleanly, never keep delivering a
  user's data on credentials that are no longer valid.
- **Many open screens**: one user opens a large number of tabs. This must not
  degrade the service for other users, and the system must be able to shed such
  a user's connections rather than exhaust its own capacity.
- **Duplicate delivery**: the same change is announced more than once. The
  screen must end in the same state as if it had been announced once.
- **A change with nothing listening**: a change is processed while the user has
  nothing open. It must not be an error, and the change must be visible the next
  time they open a screen.
- **Slow or unreachable client**: a connection stops consuming updates. The
  system must not accumulate unbounded pending updates for it.

## Requirements *(mandatory)*

### Functional Requirements

**Delivering changes**

- **FR-001**: The system MUST push a notification to a user's open screens when
  a workout of theirs changes processing status, without the user taking any
  action.
- **FR-002**: The system MUST push a notification to a user's open screens when
  training-volume figures for one of their weeks have been recomputed.
- **FR-003**: The system MUST push a notification when a workout of theirs is
  created or deleted, so screens other than the one that made the change reflect
  it.
- **FR-004**: A notification MUST identify what changed with enough precision
  for a screen to decide whether it is displaying the affected data *without
  fetching anything first* — at minimum, which workout, which week's figures,
  and, for a workout, the date it now carries. The date is required because
  processing may assign one, and a screen must be able to tell whether the
  workout concerns the week it is showing.
- **FR-005**: The system MUST deliver a user's notifications only to sessions
  authenticated as that user. A user MUST NOT receive any notification about
  another user's data, including its existence.
- **FR-006**: Establishing an update channel MUST require a valid session, and
  the system MUST stop delivering to a channel once its session is no longer
  valid.
- **FR-007**: Notifications MUST be delivered to *all* of a user's open
  sessions, not only the one that initiated a change.
- **FR-008**: A notification MUST NOT be the only copy of the data it concerns:
  the affected data MUST remain retrievable through the app's normal read paths,
  so a screen can obtain current data independently of what any notification
  carried.

**Where workouts are shown**

- **FR-009**: The dashboard's weekly list and the workout history MUST show only
  settled workouts — those whose processing has finished, whether fully or with
  items needing review. Workouts still being processed, and those that failed,
  MUST NOT appear there.
- **FR-010**: The set of workouts the lists show MUST match the set the weekly
  volume figures are computed from, so the two never describe a week differently.
- **FR-011**: The system MUST provide an in-flight surface listing the user's
  workouts that are being processed or have failed, reachable from every screen
  that offers the logging action.
- **FR-012**: A workout MUST appear in exactly one of the two places at any time
  — the in-flight surface or the settled lists — and MUST move from the first to
  the second at the moment it settles, without user action.
- **FR-013**: While the in-flight surface is closed, the control that opens it
  MUST indicate how many of the user's workouts are in flight, so in-progress
  and failed work is never invisible.
- **FR-014**: A failed workout MUST remain in the in-flight surface, described in
  terms the user can act on, until the user dismisses it. Dismissing MUST
  discard the workout.
- **FR-015**: The in-flight surface MUST state plainly when nothing is in
  progress.

**Screen behaviour**

- **FR-016**: On being notified that data it is displaying has changed, a screen
  MUST bring itself up to date without user action.
- **FR-017**: Updating a screen MUST preserve what the user has chosen: the week
  the dashboard is on, the page of history they are viewing, their scroll
  position, and any entry they have expanded.
- **FR-018**: An update MUST NOT navigate the user. The single exception: the
  session that logged a workout MAY move the dashboard to the week that workout
  settled into. No other session may change week in response to it.
- **FR-019**: A screen MUST ignore notifications about data it is not currently
  displaying.
- **FR-020**: Concurrent and repeated notifications MUST leave a screen in the
  same state as the last change alone would have — updates must be safe to
  apply more than once and safe to arrive out of order.
- **FR-021**: A screen MUST NOT lose or discard user input in progress — a
  partially filled logging form in particular — when an update arrives.

**Resilience**

- **FR-022**: A dropped channel MUST be re-established automatically, without
  the user reloading, and repeated failures MUST back off rather than retry in a
  tight loop.
- **FR-023**: After a channel is re-established, the screen MUST reflect changes
  that occurred while it was down — including workouts that settled during the
  outage, which MUST have left the in-flight surface.
- **FR-024**: The channel MUST survive an idle period with no changes — it MUST
  NOT be silently closed by inactivity in a way that leaves a screen believing it
  is still receiving updates.
- **FR-025**: A screen MUST be able to distinguish "connected and current" from
  "not receiving updates", and MUST NOT present stale data as live.
- **FR-026**: If the channel cannot be established, every screen MUST remain
  fully usable and MUST still show correct data on load, navigation, and reload,
  and the in-flight surface MUST still show the true current state when opened.
  Real-time delivery is an enhancement; loss of it MUST NOT be a failure state.
- **FR-027**: The system MUST NOT retain undelivered notifications indefinitely
  for a session that is gone or not consuming them.
- **FR-028**: The system MUST limit how many concurrent channels a single user
  can hold, so one user cannot exhaust capacity for others.

**Operability**

- **FR-029**: The system MUST record enough about channel lifecycle and delivery
  — connections opened and closed, notifications published and dropped — to
  diagnose "the user says their screen did not update" after the fact.
- **FR-030**: Delivery of a notification MUST NOT be able to fail the underlying
  change: if a workout is processed but the notification cannot be delivered, the
  processing MUST still be considered complete and durable.

### Key Entities

- **Change Notification**: An announcement that some piece of a specific user's
  data has changed. Identifies the owning user, what kind of change occurred
  (workout settled, workout created, workout deleted, weekly figures recomputed),
  and which data it concerns — the workout, its current date, the week. Carries a
  time of occurrence and an identity that lets a recipient recognise a repeat.
  It is a pointer to what changed, not a replacement for the data itself; it
  carries only what a screen needs to judge relevance without fetching first.
- **In-flight surface**: The user's view of their own workouts that have not
  settled — those still being processed, and those that failed and have not been
  dismissed. Reachable wherever logging is offered, and summarised by a count
  while closed. A workout leaves it by settling or by being dismissed.
- **Update Channel**: A live connection between one authenticated session and
  the system, over which that user's Change Notifications are delivered. Belongs
  to exactly one user, has a lifetime bounded by the session's validity, and can
  be re-established after interruption without losing changes that occurred in
  between.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A workout leaves the in-flight surface and becomes visible among
  the settled workouts within 3 seconds of the system finishing its processing,
  in 95% of cases, with no user action.
- **SC-002**: Recomputed weekly volume figures become visible on an open
  dashboard showing that week within 3 seconds of the recomputation, in 95% of
  cases.
- **SC-003**: A user completing the log-a-workout journey end to end — submit,
  wait, see the extracted exercises — needs zero page reloads, down from one
  today.
- **SC-004**: The dashboard's weekly list and its volume figures describe the
  same set of workouts 100% of the time, including while a workout of that week
  is being processed — an inconsistency that occurs today.
- **SC-005**: No workout is ever displayed inside a week it does not belong to,
  and no week on screen changes its contents because processing assigned a
  workout a different date.
- **SC-006**: A change made in one of a user's open sessions is visible in their
  other open sessions within 3 seconds.
- **SC-007**: After a connectivity interruption of up to 5 minutes, an open
  screen shows current data within 10 seconds of connectivity returning, with no
  change from the interruption left permanently invisible.
- **SC-008**: A screen left idle for 30 minutes still receives the next change
  within the SC-001 window.
- **SC-009**: With the update channel entirely unavailable, 100% of the app's
  primary journeys — sign in, log a workout, browse history, view the dashboard
  — still complete successfully, and the in-flight surface still reports the true
  state when opened.
- **SC-010**: The system sustains at least 200 concurrent update channels
  without degrading the response times of ordinary requests beyond 10% of their
  baseline.
- **SC-011**: No user ever receives a notification concerning another user's
  data — verified by test, and zero occurrences in operation.
- **SC-012**: Zero workouts remain in the in-flight surface after their
  processing has reached a terminal outcome, other than failed ones the user has
  not yet dismissed.

## Assumptions

- **Push replaces the current in-page signal.** The app already has an in-page
  mechanism that tells other components on the same tab about a locally made
  change. That mechanism is assumed to be the seam this feature replaces, so
  local changes and server-pushed changes reach screens the same way. Spec 003
  anticipated exactly this ("this module is the single place that gets
  replaced").
- **Settled means parsed or needs-review.** These are exactly the statuses the
  weekly volume computation already counts, so aligning the lists with that
  predicate is what makes FR-010 hold rather than a new rule invented here.
- **A failed workout is discarded, not retried.** Dismissing it deletes it, and
  the user logs the workout again if they still want it. Re-submitting the
  original text or image for another parsing attempt is a separate feature with
  its own value, deliberately not bundled here — see Out of Scope.
- **Only the logging session follows a workout to its week.** Spec 003's FR-012
  (the dashboard switches to the week a logged workout belongs to) is narrowed to
  the session that performed the logging, and applies when the workout settles
  rather than when it is submitted. Any other session treats a settling workout
  like any other change: refresh in place, never navigate.
- **Updates apply automatically rather than being offered.** When a screen is
  notified, it updates itself; it does not show a "new data available, click to
  refresh" prompt. This follows the precedent already set in spec 003's
  Clarifications, which considered the notification-style alternative and
  deliberately deferred it. The one thing an update may never do is move the
  user — see FR-010.
- **Notifications are thin pointers, not data.** A notification says what
  changed; the screen fetches the current data through the existing read paths.
  This keeps one definition of what the data is and one place where access is
  authorised, and means a screen that missed notifications only needs to refetch,
  not replay history. FR-008 makes this binding.
- **Delivery is best-effort, correctness comes from refetching.** The system
  does not guarantee every notification reaches every session. It guarantees
  that a session which reconnects converges on current data (FR-015). No durable
  per-user backlog is kept for sessions that are offline for a long time; a brief
  buffer covering short reconnects is sufficient.
- **The scope is the signed-in user's own data.** Workout status changes,
  workout creation and deletion, and weekly volume recomputation. No
  notifications between users, no presence, no chat, no progress percentages
  during processing — only that a terminal or meaningful change occurred.
- **The channel is one-directional.** The client receives; it does not send
  anything over this channel. All user actions continue to go through the
  existing request paths.
- **Ordering is not guaranteed across changes.** Screens converge by refetching
  current state rather than by applying an ordered log, so out-of-order arrival
  must be harmless (FR-012) rather than prevented.
- **Reuses the existing session and authorisation model.** No new identity
  concept; the channel authenticates the same user the read paths already do.
- **Deployment reality is a constraint, not a change.** The web app is a static
  client that talks to a multi-replica API behind a CDN, and background
  processing runs in a separate process that does not serve client connections.
  A change produced by that processing must therefore reach whichever replica
  happens to be holding the user's channel. This is assumed to be solved within
  this feature, using infrastructure the system already runs, without introducing
  a new datastore.
- **Analytics recomputation currently announces nothing.** Workout processing
  already emits an event; the weekly-volume recomputation does not. Adding an
  announcement for it is assumed to be in scope, since FR-002 cannot be met
  otherwise.

## Out of Scope

- Notifications delivered when the user has nothing open — push notifications,
  email, or any other out-of-app channel.
- Fine-grained progress reporting during processing (percentages, stages).
- Client-to-server messaging over the live channel.
- Collaborative or multi-user features: sharing, presence, or notifications
  about anyone else's data.
- A durable, replayable per-user event history surviving long offline periods.
- Optimistic rendering of processing results before the system has produced them.
- **Retrying a failed workout.** The submitted text or image is still stored, so
  re-running the parse is feasible and worth doing — but it needs its own way to
  re-submit work, its own attempt limit, and its own view of repeated failure.
  Bundling it here would expand this feature past the update channel that
  motivates it. Failed workouts are dismissible (FR-014) so the user is never
  stuck; recovering them is the next increment.
- Editing or correcting a workout that came back needing review.
