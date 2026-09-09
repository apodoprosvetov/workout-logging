# Specification Quality Checklist: Real-Time Updates

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-09
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Validation Notes

**Iteration 1 findings and fixes:**

1. *Implementation leakage* — an early draft named the transport and the
   fan-out mechanism directly. Both were removed from the requirements and
   restated as outcomes: FR-014/FR-016 describe reconnection and idle survival
   behaviourally, and the multi-replica/CDN reality is confined to the
   Assumptions section as a constraint the plan must satisfy, not a prescribed
   solution.
2. *Unmeasurable success criteria* — "updates feel instant" was replaced with
   SC-001/SC-002/SC-004's explicit 3-second, 95th-percentile targets, and
   SC-005/SC-006 with concrete interruption and idle windows.
3. *Unbounded scope* — an explicit **Out of Scope** section was added after the
   draft's user stories could be read as implying out-of-app push notifications
   and progress reporting.
4. *Untestable resilience wording* — "the channel should be reliable" became
   FR-014 through FR-019, each stating an observable behaviour, plus edge cases
   for duplicate delivery, slow consumers, and expired sessions.

**Clarifications deliberately resolved as assumptions rather than questions:**

- *Auto-apply vs. notify-and-let-the-user-refresh* — resolved to auto-apply,
  following the precedent set in spec 003's Clarifications, which considered the
  notification-style alternative for the analogous case and deferred it.
- *Durability of missed changes* — resolved to converge-on-reconnect with no
  durable backlog (FR-015), consistent with the thin-notification model in
  FR-008.
- *Multi-session delivery* — resolved to all of a user's sessions (FR-007),
  which is the natural consequence of pushing from the server rather than the
  originating tab.

Each of these has a defensible default and a documented rationale, so none was
raised as a blocking question. All are recorded in **Assumptions** and can be
overturned in `/speckit-clarify` if the user disagrees.

## Amendment — 2026-09-09, during `/speckit-plan`

The spec was revised mid-planning after a design decision that changed
user-visible behaviour, so the checklist was re-run against the new text.

**What changed**: workouts that have not finished processing (`pending`,
`failed`) no longer appear in the dashboard's weekly list or the workout
history; they move to a dedicated in-flight surface. US1 was rewritten, FR-009
through FR-015 added, FRs and SCs renumbered, and Edge Cases, Assumptions, and
Out of Scope extended.

**Why**: spec 003's FR-012 (the dashboard follows a logged workout to its week)
and this spec's FR-018 (an update must never navigate the user) give
contradictory answers when the parser rewrites a workout's date. Rather than
compromise, the design removes the situation — an unsettled workout is never
displayed inside a week. It also resolves a pre-existing contradiction where the
weekly list counts workouts the volume chart beside it excludes (now SC-004).

**Re-validation result**: all 16 items still pass.

- *No implementation details*: the amendment describes surfaces and behaviour
  ("in-flight surface", "settled workouts"), naming no component, framework, or
  transport. The modal/portal decision lives in `contracts/ui.md`, not here.
- *Requirements testable*: FR-009 through FR-015 each state an observable rule;
  quickstart scenarios 1–3 exercise them directly.
- *Scope bounded*: retrying a failed workout was explicitly added to Out of
  Scope rather than left implied, since dismissal invites the question.
- *Numbering continuous*: FR-001…FR-030 and SC-001…SC-012, verified with no
  gaps or duplicates.

## Notes

- All checklist items pass, before and after the amendment above.
- The technology and pattern selection the user asked for is deliberately **not**
  in the spec — it is `/speckit-plan`'s output, recorded in `research.md`. The
  Assumptions section records only the constraints that decision had to respect
  (static web client, multi-replica API behind a CDN, separate worker process,
  no new datastore).
