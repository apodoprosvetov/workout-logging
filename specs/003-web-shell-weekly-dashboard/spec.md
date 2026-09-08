# Feature Specification: Web Shell & Weekly Dashboard

**Feature Branch**: `003-web-shell-weekly-dashboard`

**Created**: 2026-09-08

**Status**: Draft

**Input**: User description: "Web app shell and week-by-week dashboard. Two related parts, both largely already implemented in the working tree (apps/web) and needing a spec written around them: (1) Application shell — the web app is restructured into two route groups, one for the signed-out pages (login, register) and one for the signed-in app; the signed-in app gets persistent chrome (a header with the app title, a 'Log workout' action and Log out, plus a left sidebar navigating between Dashboard and Workouts); logging a workout moves out of the dashboard page into a modal opened from the header, so it is reachable from anywhere in the signed-in app; the root path is a pure router sending a visitor to the dashboard when a session exists and to login otherwise; code is organised into features/, components/, services/ and lib/ reachable through path aliases. (2) Week-by-week dashboard — the dashboard shows one ISO week at a time with previous/next arrows and the week's date range as a label, going back up to 12 weeks; both dashboard panels follow the selected week (the volume-by-muscle-group chart and a list of that week's workouts); this required a new API capability so a single week can be fetched as a half-open window over performed_at; the separate workouts page keeps its own cursor-paginated full list. Known gaps to capture as requirements rather than treat as done: logging a workout from the header modal must refresh whatever list is on screen; the workouts list pagination must not drop rows that share an identical performed_at; and the styling setup must be consistent (a leftover config file is currently dead code)."

## Clarifications

### Session 2026-09-08

- Q: What should happen when a logged workout's performed date falls
  outside the week currently shown on the dashboard? → A: The dashboard
  switches to the week the workout belongs to, so the entry is always
  visible immediately. Chosen as the simple, self-evident behaviour; the
  richer alternative (stay put and surface a notification) was considered
  and deliberately deferred — see below.
- Note: **Live updates are out of scope for this feature.** A logged
  workout is handed to a background worker for parsing, so it first appears
  with a not-yet-parsed status and only later becomes parsed. Pushing that
  transition to an open screen — on the dashboard *and* the workout
  history alike — needs a mechanism this app does not have (a server-to-
  client update channel, and probably a client-side state manager to hold
  the result). That is a feature in its own right and belongs in its own
  spec. Here, FR-011 requires only that a newly logged workout appears in
  the list at whatever status it currently has; its later status change is
  not required to appear without a reload.

## Context

This feature reshapes how a signed-in user moves through the web app that
spec 001 delivered. Spec 001 put everything on one dashboard page: the
logging form, the full workout list, and the volume chart, all showing "all
time". That page answered "what have I ever logged?" but not "how did *this
week* go?" — the question a training log actually gets asked.

Most of the work described here already exists in the working tree. This
spec is written to give it a definition of done, capture the gaps found in
review, and let `/speckit-converge` sort finished work from unfinished.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Review one training week at a time (Priority: P1)

A user opens the dashboard and sees a single training week, identified by
its date range. The week's training volume per muscle group and the
workouts performed that week are both shown. Arrows step back through
previous weeks and forward again toward the present; both panels always
describe the same week.

**Why this priority**: This is the new product value. Training is planned
and reviewed in weekly cycles — an all-time total answers no useful
question, while "did I hit legs this week, and how does it compare to last
week?" is the reason to keep a log at all.

**Independent Test**: Log workouts across three different weeks, open the
dashboard, and step backwards. Each step must show only that week's
workouts and only that week's volume. Fully testable without any other
story in this spec.

**Acceptance Scenarios**:

1. **Given** a user with workouts in the current week and the previous
   week, **When** they open the dashboard, **Then** they see the current
   week's date range, and both the volume figures and the workout list
   contain only workouts performed in the current week.
2. **Given** the dashboard is showing the current week, **When** the user
   steps back one week, **Then** the date range label moves back seven
   days and both panels reload to describe that earlier week.
3. **Given** the dashboard is showing the current week, **When** the user
   looks at the forward control, **Then** it is unavailable — there is no
   week after the present one to view.
4. **Given** a user has stepped back to the oldest viewable week, **When**
   they look at the backward control, **Then** it is unavailable.
5. **Given** a week in which the user performed no workouts, **When** that
   week is selected, **Then** both panels show an explanation that this
   week is empty rather than an error or a blank area.
6. **Given** a workout performed on the last calendar day of the selected
   week, **When** that week is shown, **Then** the workout is included —
   week boundaries never drop the first or last day.

---

### User Story 2 - Log a workout from anywhere and see it land (Priority: P2)

The action to log a workout is available on every screen of the signed-in
app, not only on the dashboard. Submitting it returns the user to where
they were, and any list currently on screen reflects the new workout
without a manual page refresh.

**Why this priority**: Logging is the app's most frequent action, and
spec 001 buried it on one page. Equally important is the feedback loop:
submitting into a void and having to reload to confirm it worked
undermines trust in the whole log.

**Independent Test**: From the workouts page, log a workout and confirm it
appears in the list on screen without reloading. Repeat from the dashboard
for a workout dated inside the week being viewed.

**Acceptance Scenarios**:

1. **Given** a signed-in user on any screen of the app, **When** they look
   at the persistent chrome, **Then** a "log a workout" action is
   available.
2. **Given** the logging form is open, **When** the user submits a valid
   entry, **Then** the form closes and returns them to the screen they
   were on.
3. **Given** the user is viewing a list of workouts, **When** they log a
   workout that belongs in that list, **Then** it appears there without
   the user reloading the page.
4. **Given** the logging form is open, **When** the user dismisses it by
   any means (close control, keyboard, clicking outside), **Then** it
   closes without submitting and discards its unsent contents.
5. **Given** the dashboard is showing some week, **When** the user logs a
   workout dated in a different week, **Then** the dashboard switches to
   that workout's week and the entry is visible there.
6. **Given** a workout has just been logged and appears in a list,
   **When** the background parsing later finishes, **Then** the change of
   status is not required to appear until the screen is next loaded.
7. **Given** a signed-out visitor on the login or register screen,
   **When** they look at the chrome, **Then** neither the logging action
   nor the sign-out action is offered.

---

### User Story 3 - Move around the signed-in app (Priority: P3)

A signed-in user sees consistent chrome — the app's name, persistent
navigation between the dashboard and the full workout history, and a way
to sign out — on every screen. A visitor arriving at the app's root is
sent to the dashboard when they have a session and to the login screen
when they do not.

**Why this priority**: Structural rather than new capability — it makes
stories 1 and 2 reachable and the app navigable, but on its own it adds no
new thing a user can do.

**Independent Test**: Sign in, then move between the dashboard and the
workout history using only the persistent navigation, confirming the
current section is indicated. Sign out and confirm the login screen is
reached.

**Acceptance Scenarios**:

1. **Given** a signed-in user, **When** they view any screen of the app,
   **Then** persistent navigation to the dashboard and to the workout
   history is present, with the current section indicated.
2. **Given** a visitor with no session, **When** they open a signed-in
   screen directly by URL, **Then** they are sent to the login screen and
   no personal data is shown at any point.
3. **Given** a visitor with a valid session, **When** they open the app's
   root, **Then** they arrive at the dashboard without passing through the
   login screen.
4. **Given** a signed-in user, **When** they sign out, **Then** they
   arrive at the login screen and their stored session is discarded.
5. **Given** a user who signs in successfully, **When** authentication
   completes, **Then** they arrive at the dashboard.

---

### User Story 4 - Browse the complete history without losing entries (Priority: P3)

Separately from the week view, the user can page through their entire
workout history, newest first. Paging forward and back never skips a
workout and never shows one twice.

**Why this priority**: The full history already exists; this story is
about correctness rather than new capability. It matters because silent
data loss in a log is worse than a missing feature — the user cannot tell
it happened.

**Independent Test**: Create more workouts than fit on one page, including
several sharing an identical performed date, then page forward through the
whole history and confirm every workout appears exactly once.

**Acceptance Scenarios**:

1. **Given** a user with more workouts than fit on one page, **When** they
   page forward through the entire history, **Then** every workout appears
   exactly once across all pages.
2. **Given** several workouts recorded with an identical performed date,
   **When** the page boundary falls among them, **Then** none of them is
   skipped.
3. **Given** the user has paged forward, **When** they page back, **Then**
   they see the same entries they saw on that earlier page.
4. **Given** the user is on the first page, **When** they look at the
   backward control, **Then** it is unavailable.
5. **Given** the user is on the last page, **When** they look at the
   forward control, **Then** it is unavailable.

---

### Edge Cases

- A workout performed on the selected week's final calendar day, at any
  time of that day, must be included in the week. A workout performed at
  the very first instant of the following week must not.
- A workout dated in a week other than the one on screen is logged: see
  FR-012 — the user must not be left believing the entry was lost.
- The user views a week with an unusually high number of workouts: the
  week's list must show all of them rather than silently truncating.
- The selected week's data fails to load: each panel offers a retry
  without losing the user's week selection.
- A workout is deleted from a list: it disappears from that list without
  a full reload, and a delete that finds nothing already gone is not
  reported to the user as a failure.
- The user's session expires while a screen is open: the next action
  either renews the session transparently or returns the user to the
  login screen — never a silent failure or an infinite retry.
- The same account is signed out in another browser tab: the open tab
  stops showing personal data.
- Week boundaries and date labels are computed consistently, so a user
  near midnight or in a non-UTC timezone never sees the same workout in
  two different weeks.

## Requirements *(mandatory)*

### Functional Requirements

**Weekly review**

- **FR-001**: The dashboard MUST present exactly one training week at a
  time and MUST label it with that week's calendar date range.
- **FR-002**: Users MUST be able to step to the previous week and back
  toward the present, one week per step.
- **FR-003**: The dashboard MUST NOT offer weeks later than the current
  one, nor earlier than a fixed number of weeks in the past (see
  Assumptions).
- **FR-004**: Every panel on the dashboard MUST describe the same selected
  week; no panel may show all-time or otherwise unscoped data.
- **FR-005**: A week MUST include every workout performed on any of its
  seven calendar days and exclude every workout outside them.
- **FR-006**: The system MUST support retrieving the workouts performed
  within an arbitrary date range, so a single week can be requested
  directly rather than filtered after the fact.
- **FR-007**: A week's workout list MUST show every workout in that week
  without silently truncating.
- **FR-008**: Each panel MUST distinguish three states — loading, empty,
  and failed — and a failed panel MUST offer a retry that preserves the
  selected week.

**Logging from anywhere**

- **FR-009**: The action to log a workout MUST be reachable from every
  screen of the signed-in app.
- **FR-010**: The logging form MUST be dismissible without submitting, and
  dismissing it MUST discard its unsent contents.
- **FR-011**: After a workout is logged successfully, any list of workouts
  currently on screen MUST reflect it — at whatever processing status it
  currently holds — without the user reloading the page.
- **FR-012**: When a logged workout's performed date falls outside the week
  currently shown on the dashboard, the dashboard MUST switch to the week
  that workout belongs to, so the entry is visible without further action.
- **FR-013**: The system is NOT required to reflect a workout's later
  change of processing status on an already-open screen; that transition
  may require a reload to become visible (see Clarifications).
- **FR-014**: The logging action MUST NOT be offered to a visitor without
  a session.

**Shell and navigation**

- **FR-015**: Every screen of the signed-in app MUST show the same
  persistent chrome: the app's name, navigation between the dashboard and
  the full workout history, and a way to sign out.
- **FR-016**: The persistent navigation MUST indicate which section the
  user is currently in.
- **FR-017**: The app's root MUST route a visitor with a valid session to
  the dashboard and a visitor without one to the login screen, without
  briefly displaying the wrong destination.
- **FR-018**: Any signed-in screen opened without a valid session MUST
  redirect to the login screen without rendering personal data.
- **FR-019**: Signing out MUST discard the stored session and return the
  user to the login screen.
- **FR-020**: Signed-out screens MUST NOT offer signed-in actions.

**History**

- **FR-021**: Users MUST be able to page through their complete workout
  history, newest performed date first.
- **FR-022**: Paging MUST NOT skip or duplicate a workout, including when
  consecutive workouts share an identical performed date.
- **FR-023**: Paging controls MUST be unavailable when there is no page in
  that direction.

**Consistency**

- **FR-024**: Shared presentation of a workout — its date format, status
  label and styling, and row layout — MUST come from one definition, so
  the same workout looks the same in every list.
- **FR-025**: The project MUST NOT retain styling or build configuration
  that has no effect on the rendered application.
- **FR-026**: Source files MUST be reachable through one consistent import
  convention; a convention that resolves to nothing MUST NOT be declared.

### Key Entities

- **Training week**: A seven-day period identified by its start date and
  labelled by its calendar date range. The unit of review on the
  dashboard; every dashboard panel is scoped to exactly one.
- **Workout summary**: What a list row shows about a workout — its
  performed date, its name, and its processing status. Derived from the
  existing workout record introduced in spec 001.
- **Weekly volume entry**: Total training volume for one muscle group
  within one training week, as introduced in spec 001.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can determine how much they trained each muscle group
  in any of the last 12 weeks within 15 seconds of opening the app, using
  only the week controls.
- **SC-002**: Reviewing an adjacent week takes exactly one interaction
  from the current week.
- **SC-003**: Logging a workout takes at most two interactions from any
  screen in the signed-in app — one to open the form, one to submit.
- **SC-004**: 100% of workouts logged into the view on screen are visible
  there without the user reloading the page.
- **SC-005**: Paging through a history of at least 50 workouts, including
  at least 5 sharing an identical performed date, shows every workout
  exactly once.
- **SC-006**: A visitor without a session never sees another user's or a
  stale session's personal data, on any screen, at any point during
  loading.
- **SC-007**: Every screen of the signed-in app reaches every other screen
  through the persistent navigation, with no dead ends.

## Assumptions

- The dashboard looks back 12 weeks. Beyond that the full workout history
  serves the need; a longer window would demand aggregate views this
  feature does not cover.
- Weeks run Monday to Sunday, matching ISO week numbering already used by
  the weekly volume figures from spec 001.
- Single-user-per-account, personal use. No sharing, no coach view, no
  multi-user access to one log.
- The account model, session handling, workout ingestion, parsing, and
  weekly volume calculation from spec 001 are reused unchanged. This
  feature adds only the ability to request workouts within a date range.
- Desktop browser is the primary target. The layout should not break on a
  narrow screen, but a dedicated mobile design is out of scope.
- A single training week rarely contains more workouts than fit
  comfortably on one screen, so the week's list is not paged — but it must
  not truncate either (FR-007).
- Deployment remains the static-frontend-plus-API arrangement from spec
  002; this feature introduces no new infrastructure.

## Out of Scope

- **Live updates from background processing.** A workout is parsed
  asynchronously, so its status changes after it is logged. Reflecting
  that on an already-open screen — across the dashboard and the workout
  history both — requires a server-to-client update channel and a place
  on the client to hold shared, changing state. That is a distinct
  feature with its own architectural decisions and gets its own spec.
  This feature stops at FR-011: a workout appears when logged, at
  whatever status it holds at that moment.
- Mobile-specific layout, editing or correcting a logged workout,
  comparing two weeks side by side, and any aggregate view spanning more
  than one week.
