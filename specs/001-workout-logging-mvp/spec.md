# Feature Specification: Workout Logging MVP

**Feature Branch**: `001-workout-logging-mvp`

**Created**: 2026-08-20

**Status**: Draft

**Input**: User description: "Workout Logging MVP (ingestion + AI parsing + auth + Telegram bot) — log a workout quickly as text or a screenshot, from a phone or directly from Telegram at the gym, and let AI parse it into structured data so progress per muscle group is visible over time."

## Clarifications

### Session 2026-08-20

- Q: When a workout is marked `needs_review` (FR-013), should the user be able to manually edit/resubmit it in the MVP, or is it a status-only flag for now? → A: No editing in MVP — `needs_review` is a visible status only; manual edit/resubmit is deferred to a future iteration.
- Q: How many workout submissions per user should the ingestion rate limit allow before blocking (FR-018)? → A: 30 requests per minute per user.
- Q: How long are uploaded photos/screenshots retained, and can a user delete their data? → A: Retained indefinitely; user can delete their account and all associated data.
- Q: Are there format/size limits on photo uploads (FR-008)? → A: No limits in MVP — accept any file, rely on downstream (AI/parsing) error handling.

### Session 2026-08-21

- Q: A workout often can't fit in one photo (multi-page paper log; a Telegram album). Should a submission support multiple images? → A: Yes — up to 10 images per submission (`MAX_WORKOUT_IMAGES`), same "no format/size limits per file" as before (FR-008 revised).
- Q: With up to 10 unrestricted-size images per submission, should the raw image bytes still be retained indefinitely (as originally decided for the single-image case)? → A: No — revised: images are processed then discarded once parsing reaches a terminal status; only the derived structured workout data and the AI's raw response are retained indefinitely (FR-020 revised, research.md #11).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Log a workout as text and see it structured (Priority: P1)

A person creates an account, then logs a workout by typing a free-text
description (e.g. "Push day: bench press 80kg x8, x8, x6; overhead press
40kg x10, x10, x8"). The system understands the text and turns it into a
structured record — exercises, sets, reps, and weight — that shows up in
the person's workout history.

**Why this priority**: This is the core value proposition. Without
accurate text-to-structured-data parsing, there is no product — everything
else (Telegram, photos, dashboards) is a faster or richer way to feed this
same loop.

**Independent Test**: Can be fully tested by registering an account,
submitting one text workout through the web app, and confirming the
resulting workout, exercises, and sets are correct in the history view.
Delivers value on its own even before Telegram or photo logging exist.

**Acceptance Scenarios**:

1. **Given** a newly registered user, **When** they submit a text
   description of a workout with multiple exercises and sets, **Then** a
   workout appears in their history with each exercise and its sets
   (weight and reps) recorded correctly.
2. **Given** a submitted workout, **When** the system cannot confidently
   interpret it, **Then** the workout is marked as needing review instead
   of being silently discarded or shown as if it succeeded.

---

### User Story 2 - Log a workout from Telegram at the gym (Priority: P2) — DESCOPED (2026-09-04)

> **Not built for the MVP.** The mid-workout input channel is being
> reconsidered — a conversational MCP server (its own future spec) is a
> better fit for where this product is heading (editing, incremental
> logging, analysis, templates) than a one-shot bot. FR-003–006 and SC-004
> below are deferred with this story. The `telegram_link_codes` table and
> `users.telegram_chat_id` column already exist (InitialSchema migration)
> and are left in place, unused. US1/US3/US4 do not depend on this story.

A person links their Telegram account to their profile using a one-time
code, then logs workouts by simply messaging the bot from the gym floor,
without opening the web app.

**Why this priority**: This is the fastest logging path and the main
reason to use the product mid-workout rather than after the fact.
Depends on User Story 1's parsing pipeline but is independently
demonstrable once linking exists.

**Independent Test**: Can be fully tested by generating a linking code in
the web app, sending it to the bot to link the account, then sending a
text workout to the bot and confirming it appears in the web dashboard.

**Acceptance Scenarios**:

1. **Given** a registered user, **When** they generate a linking code and
   send it to the bot as `/start <code>`, **Then** their Telegram chat is
   bound to their account and the code can never be reused.
2. **Given** a registered user with a linked Telegram account, **When**
   they send a workout description to the bot, **Then** a structured
   workout appears in their web dashboard.
3. **Given** a Telegram chat with no linked account, **When** it sends any
   message to the bot, **Then** the bot replies with instructions for
   linking an account via the web app.

---

### User Story 3 - Log a workout from a photo or screenshot (Priority: P3)

A person logs a workout by sending a photo or screenshot (e.g. of a gym
machine's display, a handwritten note, or a workout tracking app) instead
of typing it out.

**Why this priority**: Removes the need to type when it's inconvenient,
but text logging (User Story 1) already delivers the core value, so this
is an enhancement rather than a blocker.

**Independent Test**: Can be fully tested by uploading a photo of a
workout via the web app and confirming the resulting structured workout
matches what's shown in the photo.

**Acceptance Scenarios**:

1. **Given** a registered user, **When** they upload a photo/screenshot of
   a workout via the web app, **Then** the system extracts exercises,
   sets, reps, and weight from the image and a structured workout appears
   in their history.

---

### User Story 4 - See weekly progress per muscle group (Priority: P4)

A person opens their dashboard and sees their workout history along with
a chart of weekly training volume per muscle group, so they can tell at a
glance whether they're neglecting any area.

**Why this priority**: This is the payoff for consistently logging
workouts (Stories 1-3) — it's the "so what" that makes logging worth the
effort, but it has no value until there's data to show.

**Independent Test**: Can be fully tested by logging several workouts
covering different muscle groups, then confirming the dashboard shows a
history list and a correct weekly-volume-per-muscle-group chart.

**Acceptance Scenarios**:

1. **Given** a user with several logged and successfully parsed workouts,
   **When** they open their dashboard, **Then** they see their workout
   history and a chart of weekly volume per muscle group that reflects
   those workouts.

---

### Edge Cases

- What happens when the same workout submission is delivered or processed
  more than once (e.g. a network retry)? It must not create a duplicate
  workout record.
- What happens when a user tries to view or act on another user's
  workout data (directly or via a manipulated request)? It must be
  refused — every read and write is scoped to the authenticated user.
- What happens when an exercise name in a submission doesn't match
  anything in the known exercise list? The system should still record the
  workout (marked for review if muscle-group mapping isn't possible)
  rather than dropping it.
- What happens when a user sends a linking code that has expired or was
  already used? The bot must reject it and explain why, without binding
  the chat.
- What happens when a user exceeds the linking-code attempt limit or the
  ingestion rate limit? Further attempts are rejected with a clear reason
  rather than silently failing.
- What happens when an uploaded file is corrupt, unreadable, or not
  actually a workout image? It is accepted (no upload-time format/size
  validation in MVP) and marked `needs_review` when interpretation
  fails, per FR-013.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow a person to register an account with an
  email and password.
- **FR-002**: System MUST authenticate a registered user and keep them
  signed in across a session without requiring credentials on every
  action.
- **FR-003 · FR-004 · FR-005 · FR-006**: _(Telegram account linking, chat
  binding, linking-code rate limit, unlinked-chat reply.)_ **Deferred —
  Telegram descoped from the MVP (see User Story 2, 2026-09-04).**
- **FR-007**: Users MUST be able to log a workout by submitting free text
  via the web app.
- **FR-008**: Users MUST be able to log a workout by submitting one or
  more photos/screenshots (up to 10 per submission) via the web app —
  e.g. a multi-page paper log. No format or size limits are enforced
  per image in the MVP; unparseable uploads fall back to the
  `needs_review` behavior in FR-013.
- **FR-009**: System MUST acknowledge a submitted workout back to the
  user in under 2 seconds, independent of how long full interpretation
  takes.
- **FR-010**: System MUST automatically interpret a submitted text or
  image into exercises, sets, reps, and weight.
- **FR-011**: System MUST map each recognized exercise to its muscle
  group(s) using a maintained exercise reference list that includes
  common alternate names.
- **FR-012**: When interpretation succeeds, system MUST save the
  structured workout so it is visible in the user's history.
- **FR-013**: When interpretation fails, or confidence is low, system
  MUST mark the workout as needing review rather than discarding it or
  presenting it as successfully parsed. In the MVP, `needs_review` is a
  status-only flag — no in-product editing or resubmission flow is
  required; the user may still delete the entry.
- **FR-014**: System MUST guarantee that reprocessing the same submission
  never results in a duplicate workout record.
- **FR-015**: System MUST scope every read and write of workout data to
  the authenticated user; no user's request may read or modify another
  user's data.
- **FR-016**: System MUST keep each user's weekly training volume per
  muscle group up to date as their workouts are successfully parsed.
- **FR-017**: Users MUST be able to view their workout history and a
  weekly volume per muscle group chart.
- **FR-018**: System MUST rate-limit workout submissions per user to
  prevent abuse, allowing up to 30 submissions per minute per user
  before blocking further requests.
- **FR-019**: System MUST NOT store secrets (e.g. bot credentials,
  third-party API keys) in the codebase.
- **FR-020**: Uploaded photos/screenshots are processed and then
  discarded once parsing reaches a terminal outcome (parsed,
  needs_review, or failed); their derived data — the structured
  workout (exercises/sets) and the AI's raw response — is retained
  indefinitely by default (revised 2026-08-21, research.md #11).
- **FR-021**: Users MUST be able to delete their account, which MUST
  delete all associated data (workouts, uploads, and any Telegram
  linking record if one is ever created).

### Key Entities *(include if feature involves data)*

- **User**: An account holder, identified by email.
- **Linking Code**: _(Binds a Telegram chat to an account.)_ **Deferred
  with User Story 2** — the table exists but is unused.
- **Workout**: A single logged training session for a user — has a
  status (pending / parsed / needs review / failed), a source (currently
  always `web`), and when it was performed.
- **Exercise Entry**: One exercise performed within a workout, in order,
  linked to a canonical exercise.
- **Set**: One set within an exercise entry — weight, reps, and unit, in
  order.
- **Exercise**: A canonical, named movement (e.g. "Bench Press") mapped
  to one or more muscle groups, with known alternate names.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new user can register and successfully log their first
  text workout in under 2 minutes.
- **SC-002**: Submitting a workout (text or photo) via the web app is
  acknowledged to the user in under 2 seconds.
- **SC-003**: At least 90% of clearly-formatted text workout submissions
  are parsed into fully correct structured data (right exercises, sets,
  reps, and weight) without manual correction.
- **SC-004**: _(Telegram mid-workout logging speed.)_ **Deferred with
  User Story 2.**
- **SC-005**: No user is ever able to view or modify another user's
  workout data, across every access path.
- **SC-006**: Retried or redelivered submissions never produce duplicate
  entries in a user's workout history.
- **SC-007**: A logged and successfully parsed workout is reflected in
  the user's weekly volume dashboard within a few seconds of parsing
  completing.

## Assumptions

- The MVP is used by a single real person in practice, but every entity
  is scoped by user so a second real user can be added later without
  schema or requirement changes.
- Photo submissions are static images (not video or multi-page
  documents).
- Default weight unit is kilograms; users may log sets in pounds.
- Whether a workout's name is auto-inferred by AI when the user doesn't
  provide one is a nice-to-have, deferred beyond MVP — workouts may be
  unnamed.
- Out of scope for this feature: weekly AI review and recommendations,
  program-planned-vs-actual adherence tracking, voice input,
  multi-language exercise names, a native mobile app, and manual
  editing/resubmission of `needs_review` workouts (deferred to a future
  iteration).
- Detailed technical/architecture decisions already made for this
  feature (storage systems, message broker choice, event schema, API
  routes) are captured in `design-notes.md` alongside this spec, for
  `/speckit-plan` to consume — they are intentionally omitted from this
  business-facing spec.
