# Research: Web Shell & Weekly Dashboard

**Feature**: 003-web-shell-weekly-dashboard | **Date**: 2026-09-08

Ten decisions. Most of this feature already exists in the working tree, so
several entries record *why the existing shape stays* as much as what to
build; where the review found a gap, the entry says what replaces it.

---

## 1. How a logged workout tells the screen it exists (FR-011, FR-012)

**Decision**: A module-level external store — `apps/web/services/workout-events.ts`
— holding a revision counter and the performed date of the most recently
logged workout, read through `useSyncExternalStore`. `LogWorkoutForm`
publishes on a successful POST; every list keeps the revision in its effect
dependencies and refetches; the dashboard additionally reads the published
date to decide whether to change week.

**Rationale**: The logging action lives in the header and the lists live in
pages — there is no parent component between them to hold state, and no
data-fetching library in the project. This project already solves exactly
this shape once: `services/use-require-auth.ts` wraps the localStorage token
store in `useSyncExternalStore`, with a documented rationale
(react-hooks/set-state-in-effect's own diagnostic recommends the primitive
for external mutable state). Reusing that idiom costs one small module and
no dependency.

It also matters that this is a *narrow seam*. Spec 004 will introduce live
updates from the parser worker and probably a real state manager. When it
does, this one module is what gets replaced — not five `load()` callbacks
threaded through props.

**Alternatives considered**:

- **React Context provider.** Needs a provider above both the header and the
  pages. It would work, but it re-renders every consumer on each publish and
  adds a provider to each group layout. No advantage over the store here.
- **SWR or TanStack Query.** The right long-term answer, and it would give
  cache invalidation for free. Rejected *for now*, not on merit: adopting it
  means rewriting the fetch layer in five components, and the choice is
  entangled with how live updates arrive (spec 004). Picking it here would
  commit spec 004's architecture before that spec is written.
- **`CustomEvent` on `window`.** Works, but untyped, invisible to React
  DevTools, and would sit alongside the `useSyncExternalStore` idiom already
  in the codebase rather than reusing it.

---

## 2. Pagination that cannot skip rows (FR-022)

**Decision**: Composite keyset cursor. `GET /workouts` gains an optional
`before_id`, valid only together with `before`, and the filter becomes a
row-value comparison:

```sql
WHERE (w.performed_at, w.id) < (:before, :before_id)
```

The client sends the last visible row's `performed_at` **and** its `id`.
Ordering becomes `performed_at DESC, id DESC` so the comparison and the sort
agree.

**Rationale**: The current cursor is `performed_at` alone with a strict `<`.
Rows sharing a `performed_at` that straddle a page boundary are silently
dropped — and they are not rare: the logging form uses a date input, so
`performed_at` is midnight, and two workouts on one day collide exactly.
Silent loss in a training log is the worst failure mode available here,
because the user cannot detect it.

A row-value comparison is a single indexable predicate in Postgres, so this
stays one index scan. `id` is a UUID, so its order is arbitrary — irrelevant
for a tie-break, which only needs to be *stable* and *total*.

**Alternatives considered**:

- **Client-side dedup by id, fetching with overlap.** No API change, but it
  makes "has another page" unreliable and leaks pagination correctness into
  every consumer.
- **`OFFSET`/`LIMIT`.** Simple and correct against duplicates, but shifts
  under concurrent inserts and scans more rows per page as history grows.
  Keyset is already the established pattern here (contracts/api.md).
- **Tie-break on `created_at`.** Not unique in principle; `id` is.

---

## 3. Index for the composite cursor

**Decision**: Replace `IDX_e6a14b328d153b3050dd0773af` — currently
`("user_id", "performed_at")` — with `("user_id", "performed_at" DESC, "id" DESC)`,
in a new migration.

**Rationale**: The existing index was added for exactly this read path
(`AddIndexesForWorkoutReadPaths`). Extending it to carry the tie-break
column in matching sort order lets the row-value comparison in decision 2
seek directly instead of filtering after the fact. This is the only schema
change in the feature.

**Alternatives considered**: Adding a second index and leaving the first —
rejected; the new one is a strict superset for this query, and an unused
index still costs write time.

---

## 4. A week's list must not truncate (FR-007)

**Decision**: The dashboard's weekly list requests an explicit `limit` of
100 (the DTO's documented maximum) rather than relying on the API default.

**Rationale**: `WorkoutsService` applies `DEFAULT_LIMIT = 20` when no limit
is given. A bounded week query silently losing its 21st workout is the same
class of invisible failure as decision 2. 100 is far above any real week and
already the contract's ceiling, so no contract change is needed.

**Alternatives considered**: Making `limit` unbounded when both `after` and
`before` are present — rejected, it makes the endpoint's worst case depend
on the caller's window rather than a fixed cap.

---

## 5. One root layout, not two (FR-015 – FR-020)

**Decision**: Collapse to a single root layout at `app/layout.tsx` carrying
`<html>`, `<body>`, fonts and metadata. `(auth)/layout.tsx` and
`(main)/layout.tsx` become plain nested layouts that add only their chrome.

**Rationale**: Two root layouts means every navigation crossing the group
boundary is a full document load, not a client transition. That boundary is
crossed on the two most common transitions in the app: sign-in → dashboard,
and sign-out → login. Beyond the visible pause, a full document load
discards all module-level state — including the store from decision 1 — so
keeping two roots would quietly make that store's lifetime harder to reason
about. The current duplication (fonts and metadata declared identically in
both files) is a symptom of the same thing.

**Alternatives considered**: Keeping two root layouts and accepting the
reload — rejected; the cost is paid on every sign-in for no benefit, since
the chrome difference is expressible in nested layouts.

---

## 6. Tailwind configuration has one home (FR-025)

**Decision**: Delete `apps/web/tailwind.config.js`. Any theme extension is
expressed in the existing `@theme` block in `app/globals.css`.

**Rationale**: This is Tailwind v4, which does not auto-load a JS config —
it must be pointed at with a `@config` directive, and `globals.css` has
none. Verified: no `@config` in the stylesheet, and the token the config
defines (`Graphik`) appears nowhere in the built CSS. The file also contains
a `variants:` block, which is Tailwind v2 syntax removed in v3. It is dead
code that reads as live configuration, which is worse than no file.

Related, and to fix while there: `globals.css` sets
`body { font-family: Arial, Helvetica, sans-serif }`, which overrides the
Geist variables the layout defines. The body rule should use the
`--font-sans` token so the declared font is the rendered one.

**Alternatives considered**: Adding `@config '../tailwind.config.js'` to
revive the file — rejected; it would split theme definitions across two
files and two config dialects for no gain.

---

## 7. One import convention, all aliases real (FR-026)

**Decision**: Use the semantic aliases (`@components/*`, `@features/*`,
`@services/*`, `@hooks/*`, `@lib/*`) exclusively; no mixed `@/features/...`
form. Move `use-require-auth.ts` from `services/` into `hooks/`, which makes
`@hooks/*` resolve to something real.

**Rationale**: The restructure introduced the aliases but left both forms in
use — `@/lib/workouts` in three files, `@lib/workouts` in another, for the
same module. Meanwhile `@hooks/*` points at a directory holding only
`.gitkeep`. A declared path that resolves to nothing is a trap for the next
person. Splitting on "IO clients in `services/`, React hooks in `hooks/`,
pure helpers and contract types in `lib/`" gives each alias a stated meaning.

**Alternatives considered**: Dropping the semantic aliases for a single
`@/*` — rejected; the grouping is the point of the restructure and reads
well at import sites.

---

## 8. Workout rows are defined once (FR-024)

**Decision**: Extract the list rendering into a shared
`components/workout-table.tsx`, taking rows and an `onDelete` handler.

**Rationale**: The weekly list and the history list currently contain the
same ~40 lines — column header, row map, status badge, delete control —
identical except for the variable name, plus near-identical delete handlers.
FR-024 requires one definition so the same workout looks the same
everywhere; today a change to the status badge has to be made twice, and
the two will drift.

**Alternatives considered**: Keeping the shared grid constant
(`WORKOUT_ROW_GRID`) and duplicating the markup — that is the current state,
and it already failed to prevent the copy.

---

## 9. Weeks are ISO weeks in UTC

**Decision**: A week runs Monday 00:00 UTC to the following Monday 00:00
UTC, exclusive. The client sends that pair as `after`/`before`.

**Rationale**: Spec 001's weekly volume is keyed by `isoWeekKey` in
`packages/shared`, which is UTC-based. FR-004 requires every dashboard panel
to describe the same week — so the workout list must use the identical
definition, or the two panels would disagree about a workout near a
boundary while both claim the same date range. Local-time weeks would need
the volume aggregation redefined too, which is out of this feature's scope.

**Consequence to accept**: a user well east of UTC logging late on a Sunday
evening local time sees that workout in the following week. For a
single-user personal log this is a known, documented rounding, not a defect.

**Alternatives considered**: Local-timezone weeks — rejected as above;
revisit if the app ever gains users across timezones.

---

## 10. What gets tested

**Decision**: Contract tests in `apps/api/tests/contract/workouts.list.spec.ts`
for the new `before_id` parameter, following the file's existing style. No
test framework is introduced for `apps/web`; its verification is
`tsc --noEmit`, `eslint`, `next build`, and the manual scenarios in
`quickstart.md`.

**Rationale**: The standing project rule is that every new or changed
`apps/api` route gets contract tests, while other quality work is deferred —
`after` was already covered this way in the working tree, and `before_id`
must match. Standing up a component-test toolchain for `apps/web` is a
larger decision than this feature should make on the way past.

**Risk accepted**: FR-011, FR-012 and FR-022's client half are verified by
hand. They are written as explicit quickstart scenarios so the check is
repeatable rather than remembered.
