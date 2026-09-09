# UI Contract: Real-Time Updates

Extends [spec 003's UI contract](../../003-web-shell-weekly-dashboard/contracts/ui-routes.md).
No new routes. The change is *where workouts appear* and one new overlay
surface, decided in [research.md](../research.md) #5.

---

## The partition

Every workout is in exactly one of two places, decided solely by `status`
(FR-012):

| Status | Surface |
|---|---|
| `parsed` | settled lists |
| `needs_review` | settled lists |
| `pending` | in-flight modal |
| `failed` | in-flight modal, until dismissed |

The settled pair is exactly the predicate `computeWeeklyVolume` already uses
(`packages/shared/src/analytics.ts:82`), which is what makes the weekly list and
the volume chart agree (FR-010, SC-004).

---

## Changed surfaces

### Dashboard weekly list (`apps/web/features/dashboard/weekly-workouts.tsx`)

- Fetches with `?status=parsed&status=needs_review`.
- Refetches on `workout.settled`, `workout.deleted`, and `workout.created` whose
  `performed_at` falls in the displayed week; ignores everything else (FR-019).
- **Never changes week in response to a notification** (FR-018), with the single
  exception below.

### Workout history (`apps/web/features/workouts/workout-list.tsx`)

- Same status filter; refetches on any workout notification for the user.
- Keeps its existing page and scroll position across a refetch (FR-017), and
  keeps the request-sequencing guard that already prevents an older response
  from overwriting a newer one.

### `WorkoutTable` (`apps/web/components/workout-table.tsx`)

Shared by both lists. It will now only ever receive settled workouts, but the
status badge stays — `needs_review` still needs to be distinguishable from
`parsed`. `statusLabel`/`statusBadgeClass` keep all four entries: the modal
renders `pending` and `failed` with the same vocabulary.

---

## New surface: in-flight modal

**Opened from**: the logging control, wherever it appears (FR-011). It is the
same control the user already presses to log a workout, so the flow is
"log → watch it land" in one place rather than two.

**Rendered via a portal**, so it escapes the header's stacking and layout
context and is not clipped by it.

**Contents**

| State | Display |
|---|---|
| `pending` items | The workout with a processing indicator. No exercise detail — there is none yet. |
| `failed` items | The workout, an explanation the user can act on, and a dismiss action (FR-014). |
| neither | An explicit "nothing in progress" statement, not a blank panel (FR-015). |

**Closed-state indicator**: the opening control shows the count of in-flight
workouts (FR-013). This is what keeps the design honest — without it, closing
the modal would make in-progress work invisible, which is worse than the status
badge it replaces.

**Data source**: `GET /workouts?status=pending&status=failed`, refetched on
`workout.settled`, `workout.created`, and `workout.deleted`.

**Dismiss**: `DELETE /workouts/:id`. Dismissing is deleting (research #6); the
UI must say so plainly rather than implying the workout is merely hidden.

---

## The one permitted navigation

FR-018 forbids an update from navigating the user, with a single exception:

> The session that logged a workout may move the dashboard to the week that
> workout settled into.

Conditions, all required:

1. This session performed the logging (not another tab, not another device).
2. The notification is `workout.settled` with status `parsed` or `needs_review`.
3. `performed_at` falls outside the week currently displayed.

This is spec 003's FR-012 narrowed — it now fires on *settling* rather than on
submission, at a moment when the user is looking at the modal tracking that very
workout. A `failed` settle never navigates: there is nothing to navigate to.

Every other session treats the same notification as an ordinary refresh
(FR-018, US3 scenario 3).

---

## Channel status in the UI

The client exposes `connecting | live | offline` (see
[data-model.md](../data-model.md)). Requirements on how screens use it:

- `offline` MUST NOT be presented as an error or block anything — the app is
  fully usable without the channel (FR-026).
- Screens MUST NOT imply data is live while `offline` (FR-025).
- The in-flight modal, opened while `offline`, still fetches on open, so it
  shows the true current state rather than a stale snapshot (FR-026).

Deliberately not specified here: the visual treatment. That is a design choice,
not a contract, so long as the three rules above hold.

---

## Replaced module

`apps/web/services/workout-events.ts` is replaced, not extended. Spec 003 named
this explicitly:

> Deliberately NOT a general workout cache. It announces newly logged workouts
> only — the later pending → parsed transition produced by the worker is out of
> scope by contract (FR-013) and gets its own spec. When that lands, this module
> is the single place that gets replaced.

Its successor keeps the same shape — an external store read through
`useSyncExternalStore`, with a `revision` consumers put in effect dependencies —
so the existing call sites change as little as possible. What changes is the
source: notifications now arrive from the server, and locally originated changes
publish into the same store, so both reach screens by one path (spec
Assumptions, "Push replaces the current in-page signal").
