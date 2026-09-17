# Data Model: Real-Time Updates

**Feature**: 004-realtime-updates | **Date**: 2026-09-09

This feature adds **no persistent schema**. There is no migration, no new table,
no new collection. Everything below is either an in-memory structure scoped to
one API process, a message shape in flight, or a client-side view state.

That is a deliberate consequence of research #4: notifications are pointers, and
the durable truth stays where it already lives — `workouts` in Postgres, the
weekly hashes in Redis, the raw uploads in GridFS.

---

## Existing entities this feature reads

### `Workout` (Postgres, `packages/shared/src/entities/workout.entity.ts`)

Unchanged. Two of its existing fields become load-bearing for the UI split:

| Field | Why it matters here |
|---|---|
| `status` | Partitions the UI. `parsed` and `needs_review` are **settled** and belong to the lists; `pending` and `failed` are **in flight** and belong to the modal (FR-009, FR-011). |
| `performedAt` | Carried in the settled notification so a screen can judge week relevance without fetching (FR-004). May be rewritten by the parser when `performedAtExplicit` is false. |

**State transitions** (all produced by `apps/worker`, none new):

```
                    ┌──────────────► parsed        ─┐
                    │                               │ settled → lists
pending ────────────┼──────────────► needs_review  ─┘
   │                │
   │                └──────────────► failed         ─┐ in flight → modal
   │                                                 │
   └── deleted / dismissed ───────► (row removed)   ─┘
```

`pending` is the only non-terminal state. The three terminal states differ only
in which surface owns them. Dismissing a `failed` workout deletes the row
(FR-014) — it is the existing delete path, not a new state.

### Weekly volume hash (Redis)

Unchanged: `weekly_volume:{userId}:{isoWeek}`
(`packages/shared/src/analytics.ts:33`). This feature only announces that a
given key was rewritten; it never reads or writes it.

---

## New in-flight structures

### Connection registry (in-memory, per API replica)

Not shared between replicas, and intentionally so — it describes sockets this
process owns, which no other process can act on (research #10).

| Field | Type | Notes |
|---|---|---|
| `userId` | string | Key. |
| `connections` | set of open stream handles | One entry per open screen for that user on this replica. |

Rules:

- An entry is removed when the connection's own close/abort event fires, never
  by a periodic sweep — a client that disappears without a clean close must not
  leak (FR-027).
- A new connection beyond the per-user cap is refused (FR-028). The cap is
  per-replica; exact global accounting is explicitly not a goal.
- The registry is empty at process start and is not persisted. A replica restart
  drops its connections; clients reconnect (FR-022) and resync (FR-023).

### Redis Pub/Sub channel

| Aspect | Value |
|---|---|
| Channel name | one per user, derived from the user id |
| Payload | a single JSON `ChangeNotification` (see `contracts/events.md`) |
| Durability | none — dropped if no replica is subscribed, which is FR-027 |
| Ordering | not guaranteed across notifications; safe because notifications carry no data (FR-020) |

A per-user channel rather than one global channel with client-side filtering:
filtering after delivery would mean every replica receives every user's
notifications, and a bug in the filter is a cross-user data leak (FR-005). The
channel name is the authorization boundary.

---

## Client-side view state (`apps/web`)

### In-flight collection

Backed by `GET /workouts?status=pending&status=failed`, refetched on
notification. Held in the external store that replaces
`apps/web/services/workout-events.ts` (spec 003 named that module as the seam
this feature takes over).

| Field | Purpose |
|---|---|
| `items` | The workouts to render in the modal. |
| `count` | Badge on the logging control while the modal is closed (FR-013). |
| `revision` | Bumped on every applied change; lists keep it in effect dependencies, as today. |

### Channel status

| Value | Meaning |
|---|---|
| `connecting` | First attempt, or reconnecting after a drop. |
| `live` | Stream open and a heartbeat seen within two intervals. |
| `offline` | Not receiving updates. Screens must not present their data as live (FR-025), and everything must still work (FR-026). |

`live` deliberately depends on the heartbeat rather than on the socket being
open, because a stream cut by an intermediary can leave a socket that looks
healthy and never delivers again (research #9).

---

## What is deliberately absent

- **No stored event log.** Missed notifications are not replayed; a reconnecting
  client refetches current state (FR-023). A durable per-user history is out of
  scope in the spec.
- **No delivery receipts or per-connection cursors.** Nothing tracks what a
  given screen has seen — thin notifications make that unnecessary.
- **No new workout status.** "In flight" and "settled" are groupings over the
  four existing statuses, not a fifth column.
