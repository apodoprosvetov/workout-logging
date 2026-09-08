# Research: Web Shell & Weekly Dashboard

**Feature**: 003-web-shell-weekly-dashboard | **Date**: 2026-09-08

Eleven decisions. Most of this feature already exists in the working tree, so
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

**Revised 2026-09-08.** This entry originally specified a composite keyset
cursor (`before_id`). It was replaced by page/per_page offset pagination in a
shared envelope after the failure was reproduced and the two options compared
on real data. The keyset design is recorded under Alternatives below.

**Decision**, in two parts:

1. **The ordering becomes a total order**: `ORDER BY performed_at DESC, id DESC`.
2. **Pagination becomes offset-based and shared**: every list endpoint takes
   `page` (default 1) and `per_page` (default 20, max 100) and answers in one
   envelope — `{ data, total, page, per_page, next_page, prev_page }`. `limit`
   is retired.

**Rationale**: The original cursor was `performed_at` alone with a strict `<`.
Reproduced against Postgres 16 on the real schema: with 22 workouts of which
three share `2026-02-10T00:00:00Z`, page 1 (`limit=21`) ends inside the tie
group, the client sends that row's `performed_at` as the cursor, and page 2
(`performed_at < 2026-02-10`) returns **zero rows** — two workouts become
unreachable from the UI entirely. Not a corner case: the logging form uses a
date input, so `performed_at` is midnight and same-day workouts collide
exactly.

Part 1 is the real fix and is required by *either* pagination scheme. Measured
on the same data: the same three tied rows come back `A,B,C` under a
sequential scan and `C,B,A` under an index scan. `ORDER BY performed_at DESC`
is not a total order, so tied rows have no defined position — and paginating
over an undefined position is unsound however the cursor is expressed.

Part 2 is then a genuinely free choice, and offset wins on this project's
terms: page position is one integer instead of a cursor stack, `total` becomes
available (the client's over-fetch-by-one hack to guess "is there more"
disappears), and one envelope serves every future list endpoint. Its known
weakness — pages shifting when rows are inserted or deleted mid-browse — costs
a single-user log with a few hundred workouts almost nothing, and its
`offset + limit` scan cost is immaterial at that size.

**Alternatives considered**:

- **Composite keyset cursor (`before_id`)**, the original decision:
  `WHERE (performed_at, id) < (:before, :before_id)`. Strictly more correct —
  immune to shifting, constant cost at any depth. Rejected as
  disproportionate: it needs a cursor pair threaded through the client, a
  cross-field validation rule, and it still would not have worked without
  part 1. Revisit if the history ever grows into the tens of thousands or
  gains concurrent writers.
- **Client-side dedup by id, fetching with overlap.** No API change, but it
  makes "has another page" unreliable and leaks pagination correctness into
  every consumer.
- **Tie-break on `created_at`.** Not unique in principle; `id` is.
- **`nestjs-paginate` / `nestjs-typeorm-paginate`** — see decision #11.

---

## 3. Index for the total ordering

**Decision**: Replace `IDX_e6a14b328d153b3050dd0773af` — currently
`("user_id", "performed_at")` — with `("user_id", "performed_at", "id")`,
ascending, in a new migration.

**Rationale**: The existing index was added for exactly this read path
(`AddIndexesForWorkoutReadPaths`). Now that the ordering ends in `id`
(decision 2, part 1), the two-column index no longer satisfies the sort on its
own and Postgres has to add a sort step on top. Carrying the tie-break column
in matching order removes it. This is the only schema change in the feature,
and it is needed whichever pagination scheme is used — it follows from the
ordering, not from the cursor.

**Ascending, not DESC**, though the ordering is `DESC, DESC`: a btree is
readable in either direction, so a uniformly-descending sort is satisfied by an
ascending index scanned backwards. Confirmed with `EXPLAIN` after applying it —
`Index Scan Backward`, no sort node, where the two-column index left an
`Incremental Sort` on top. Direction in an index only matters for a
mixed-direction `ORDER BY`, and TypeORM's `@Index` cannot express one anyway,
so a DESC index would guarantee permanent entity/schema divergence.

**Alternatives considered**: Adding a second index and leaving the first —
rejected; the new one is a strict superset for this query, and an unused
index still costs write time.

---

## 4. A week's list must not truncate (FR-007)

**Decision**: The dashboard's weekly list requests an explicit `per_page` of
100 (the contract's maximum) rather than relying on the API default.

**Rationale**: A list endpoint applies `DEFAULT_PER_PAGE = 20` when none is
given. A bounded week query silently losing its 21st workout is the same class
of invisible failure as decision 2. 100 is far above any real training week and
already the contract's ceiling, so no contract change is needed.

A week is deliberately fetched whole rather than paged: it is a bounded window
the user reviews as one thing, and paging inside it would answer a question
nobody asks.

**Alternatives considered**: Making `per_page` unbounded when both `after` and
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

---

## 11. Build the pagination helper rather than take a dependency

**Added 2026-09-08**, alongside decision #2's revision.

**Decision**: A small shared helper in `apps/api/src/common/` —
`PaginationQueryDto` (a base class list DTOs extend) plus a `paginate()`
function that applies skip/take, runs `getManyAndCount()`, and returns the
envelope. No new dependency.

**Rationale**: NestJS ships no pagination of its own, so the question was
whether to adopt one of the two established packages. Neither fits:

- **`nestjs-paginate@15`** declares a peer of `typeorm: ^1.0.0`; this project
  is on 0.3.20. Version 13.5.1 does support `typeorm ^0.3.17`, but both
  majors also peer-depend on `@nestjs/swagger`, which this project does not
  use and would be pulling in solely to satisfy a resolver. More importantly
  it *owns the query syntax* (`?sortBy=performedAt:DESC&filter.status=$eq:parsed`),
  which would replace the hand-written DTO and the deliberate `after`/`before`
  window semantics this feature depends on. Its envelope is `{data, meta, links}`.
- **`nestjs-typeorm-paginate@4.1.0`** matches the version matrix exactly, but
  does not parse query params at all — the caller passes `{page, limit}` — so
  it contributes only the count, the arithmetic and an `{items, meta, links}`
  envelope. About fifteen lines, in a shape we would then have to translate.

Both would have to be fought to produce the agreed envelope. The helper as
built is around forty lines and owns exactly the behaviour the contract
promises.

**Also decided here**: a base DTO class rather than a `@Pagination()` param
decorator. `main.ts` installs a global
`ValidationPipe({ whitelist, forbidNonWhitelisted, transform })`, so an
inherited DTO is already coerced and validated, and `limit` now returns 400
for free. A custom decorator would run outside that pipe and have to
reimplement all of it.

**Scope note**: `GET /workouts` is currently the only list endpoint —
`GET /analytics/weekly-volume` returns a single week's aggregate, not a list.
The abstraction therefore generalises from one case, and was deliberately kept
thin for that reason; the second list endpoint gets to reshape it.
