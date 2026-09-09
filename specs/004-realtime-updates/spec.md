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

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A logged workout finishes processing on screen (Priority: P1)

A user logs a workout and stays on the page. The entry appears immediately in a
not-yet-processed state. Moments later, without touching anything, the entry
resolves in place: it shows the exercises and sets that were extracted from what
they submitted, and its status is no longer pending.

**Why this priority**: This is the gap that makes the product feel broken. It is
the one moment where the user is actively waiting for the system, and today the
system gives them nothing to wait on. Delivered alone, it removes the only
mandatory page reload in the core flow and is a complete, demonstrable
improvement.

**Independent Test**: Log a workout on an open screen and do nothing else.
Without any user action — no reload, no navigation, no click — the entry must
change from its pending state to its resolved state and show the extracted
exercise detail.

**Acceptance Scenarios**:

1. **Given** a user is viewing their workout history with a just-logged workout
   showing as not-yet-processed, **When** background processing finishes
   successfully, **Then** that entry updates in place to its processed state
   with its exercise detail visible, without the user reloading or navigating.
2. **Given** a user is viewing the dashboard with a just-logged workout in the
   current week's list, **When** background processing finishes, **Then** the
   dashboard's list reflects the processed entry without a reload.
3. **Given** a user is viewing a workout that is still processing, **When**
   processing fails permanently, **Then** the entry updates on screen to a
   failed state that tells the user the workout could not be read, rather than
   remaining pending forever.
4. **Given** a workout resolves to a state needing review, **When** the update
   arrives, **Then** the entry shows that reviewable state rather than a
   successful one.
5. **Given** an entry updates in place, **When** the user was scrolled down or
   had a different entry expanded, **Then** their scroll position and expanded
   entry are preserved.

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
   logged on one finishes processing, **Then** both devices show the processed
   entry.
3. **Given** two different users each have the app open, **When** one user's
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
- **Update for data not on screen**: a workout in a week the dashboard is not
  showing, or on a page of history the user has not scrolled to, is processed.
  The screen must not be disrupted and must not silently jump.
- **Deleted while processing**: a workout is deleted before its processing
  finishes. The screen must not resurrect the deleted entry when the processing
  update arrives.
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
  for a screen to decide whether it is displaying the affected data — at minimum,
  which workout, and which week's figures.
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

**Screen behaviour**

- **FR-009**: On being notified that data it is displaying has changed, a screen
  MUST bring itself up to date without user action.
- **FR-010**: Updating a screen MUST preserve what the user has chosen: the week
  the dashboard is on, the page of history they are viewing, their scroll
  position, and any entry they have expanded.
- **FR-011**: A screen MUST ignore notifications about data it is not currently
  displaying.
- **FR-012**: Concurrent and repeated notifications MUST leave a screen in the
  same state as the last change alone would have — updates must be safe to
  apply more than once and safe to arrive out of order.
- **FR-013**: A screen MUST NOT lose or discard user input in progress — a
  partially filled logging form in particular — when an update arrives.

**Resilience**

- **FR-014**: A dropped channel MUST be re-established automatically, without
  the user reloading, and repeated failures MUST back off rather than retry in a
  tight loop.
- **FR-015**: After a channel is re-established, the screen MUST reflect changes
  that occurred while it was down.
- **FR-016**: The channel MUST survive an idle period with no changes — it MUST
  NOT be silently closed by inactivity in a way that leaves a screen believing it
  is still receiving updates.
- **FR-017**: A screen MUST be able to distinguish "connected and current" from
  "not receiving updates", and MUST NOT present stale data as live.
- **FR-018**: If the channel cannot be established, every screen MUST remain
  fully usable and MUST still show correct data on load, navigation, and reload.
  Real-time delivery is an enhancement; loss of it MUST NOT be a failure state.
- **FR-019**: The system MUST NOT retain undelivered notifications indefinitely
  for a session that is gone or not consuming them.
- **FR-020**: The system MUST limit how many concurrent channels a single user
  can hold, so one user cannot exhaust capacity for others.

**Operability**

- **FR-021**: The system MUST record enough about channel lifecycle and delivery
  — connections opened and closed, notifications published and dropped — to
  diagnose "the user says their screen did not update" after the fact.
- **FR-022**: Delivery of a notification MUST NOT be able to fail the underlying
  change: if a workout is processed but the notification cannot be delivered, the
  processing MUST still be considered complete and durable.

### Key Entities

- **Change Notification**: An announcement that some piece of a specific user's
  data has changed. Identifies the owning user, what kind of change occurred
  (workout status resolved, workout created, workout deleted, weekly figures
  recomputed), and which data it concerns (the workout, the week). Carries a
  time of occurrence and an identity that lets a recipient recognise a repeat.
  It is a pointer to what changed, not a replacement for the data itself.
- **Update Channel**: A live connection between one authenticated session and
  the system, over which that user's Change Notifications are delivered. Belongs
  to exactly one user, has a lifetime bounded by the session's validity, and can
  be re-established after interruption without losing changes that occurred in
  between.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A workout's processing outcome becomes visible on an already-open
  screen within 3 seconds of the system finishing it, in 95% of cases, with no
  user action.
- **SC-002**: Recomputed weekly volume figures become visible on an open
  dashboard showing that week within 3 seconds of the recomputation, in 95% of
  cases.
- **SC-003**: A user completing the log-a-workout journey end to end — submit,
  wait, see the extracted exercises — needs zero page reloads, down from one
  today.
- **SC-004**: A change made in one of a user's open sessions is visible in their
  other open sessions within 3 seconds.
- **SC-005**: After a connectivity interruption of up to 5 minutes, an open
  screen shows current data within 10 seconds of connectivity returning, with no
  change from the interruption left permanently invisible.
- **SC-006**: A screen left idle for 30 minutes still receives the next change
  within the SC-001 window.
- **SC-007**: With the update channel entirely unavailable, 100% of the app's
  primary journeys — sign in, log a workout, browse history, view the dashboard
  — still complete successfully.
- **SC-008**: The system sustains at least 200 concurrent update channels
  without degrading the response times of ordinary requests beyond 10% of their
  baseline.
- **SC-009**: No user ever receives a notification concerning another user's
  data — verified by test, and zero occurrences in operation.
- **SC-010**: Zero workouts are left displayed as permanently pending on an open
  screen after their processing has reached a terminal outcome.

## Assumptions

- **Push replaces the current in-page signal.** The app already has an in-page
  mechanism that tells other components on the same tab about a locally made
  change. That mechanism is assumed to be the seam this feature replaces, so
  local changes and server-pushed changes reach screens the same way. Spec 003
  anticipated exactly this ("this module is the single place that gets
  replaced").
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
