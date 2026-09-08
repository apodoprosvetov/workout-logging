---

description: "Task list for 003-web-shell-weekly-dashboard"
---

# Tasks: Web Shell & Weekly Dashboard

**Input**: Design documents from `/specs/003-web-shell-weekly-dashboard/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: Contract tests are included for `apps/api` only — the standing project rule is that every new or changed API route is contract-tested (research #10). No test framework is introduced for `apps/web`; it is verified by `tsc`, `eslint`, `next build`, and [quickstart.md](./quickstart.md).

**Organization**: Tasks are grouped by user story so each can be implemented and validated independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story the task belongs to (US1–US4)
- Exact file paths are given in every task

## Path Conventions

npm-workspaces monorepo (plan.md → Project Structure): `apps/web/`, `apps/api/`, `packages/shared/`. All paths below are repository-relative.

---

## Working-Tree Status

Unusually for a task list, **much of this feature already exists in the
working tree** — it was built before the spec was written. Tasks below
describe the feature's complete definition of done, not a from-scratch
build. Several will turn out to be already satisfied.

Verified in this session: `tsc --noEmit`, `eslint`, and `next build` all
pass on the current tree, and the build still prerenders all five routes.
`GET /workouts`'s `after` parameter and its three contract tests are already
in place.

The four gaps review found are, in task terms: **T009 + T017–T021** (a
logged workout reaching the screen), **T030–T036** (pagination dropping
rows), **T001** (dead Tailwind config), **T008 + T014 + T037** (duplicated
row markup). Everything else is likely reconciliation.

Run `/speckit-converge` after this to sort finished from unfinished rather
than trusting this note.

---

## Phase 1: Setup (Shared Configuration)

**Purpose**: Remove configuration that misrepresents how the app is styled

- [X] T001 [P] Delete `apps/web/tailwind.config.js` — Tailwind v4 does not auto-load a JS config and `app/globals.css` has no `@config` directive, so the file is dead code that reads as live configuration; it also contains a v2-era `variants:` block (FR-025, research #6)
- [X] T002 [P] In `apps/web/app/globals.css`, change the `body` rule's `font-family` from the hardcoded `Arial, Helvetica, sans-serif` to the `--font-sans` token, so the Geist fonts the layout declares are the fonts actually rendered (research #6)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Structural corrections and shared modules that every user story below depends on

**⚠️ CRITICAL**: No user story work should begin until this phase is complete — T003–T005 move files every story touches, and T008/T009 are imported by three stories

- [X] T003 Create `apps/web/app/layout.tsx` as the single root layout, holding `<html>`, `<body>`, the Geist font setup and the `metadata` export — currently duplicated verbatim across two group layouts (research #5)
- [X] T004 Reduce `apps/web/app/(auth)/layout.tsx` to a nested layout that renders only `<Header showLogout={false} />` and its children — it must no longer render `<html>` or `<body>` (research #5)
- [X] T005 Reduce `apps/web/app/(main)/layout.tsx` to a nested layout that renders only `<Header />`, `<Sidebar />` and its children — it must no longer render `<html>` or `<body>`, so navigating between the two route groups stops costing a full document load (research #5)
- [X] T006 Move `apps/web/services/use-require-auth.ts` to `apps/web/hooks/use-require-auth.ts` and delete `apps/web/hooks/.gitkeep`, so the declared `@hooks/*` alias resolves to a real directory; preserve the hook's existing behaviour of reading the token store directly inside the effect rather than keying the redirect off the subscribed value (FR-026, contracts/ui-routes.md → Auth behaviour)
- [X] T007 Normalize every import across `apps/web` to the semantic alias form (`@components/*`, `@features/*`, `@services/*`, `@hooks/*`, `@lib/*`); the mixed `@/features/...` and `  /...` form currently coexists with it for the same modules (FR-026, research #7)
- [X] T008 [P] Create `apps/web/components/workout-table.tsx` exporting one workout list definition — column header row, row rendering, status badge, and delete control — taking rows plus an `onDelete` handler; this markup is currently duplicated near-verbatim between the weekly list and the history list (FR-024, research #8, data-model.md → WorkoutRow)
- [X] T009 [P] Create `apps/web/services/workout-events.ts` — a module-level store exposing `revision` (integer) and `lastPerformedAt` (ISO string or null), read through `useSyncExternalStore`, following the existing token-store idiom; producer and consumers are wired in Phase 4 (research #1, contracts/ui-routes.md → Logged-workout signal, data-model.md §3)

**Checkpoint**: Layouts collapsed, aliases all real, shared row component and event store exist — user stories can begin

---

## Phase 3: User Story 1 - Review one training week at a time (Priority: P1) 🎯 MVP

**Goal**: The dashboard shows exactly one ISO week — its date range, its volume by muscle group, and its workouts — with arrows stepping between weeks

**Independent Test**: Seed workouts across three different weeks (quickstart.md Scenario 1), open the dashboard, and step backwards. Each step must show only that week's workouts and only that week's volume.

- [X] T010 [US1] In `apps/web/features/dashboard/dashboard.tsx`, hold `weeksAgo` (0–12) as the dashboard's only week state, render the week's date range label, and disable the forward control at `weeksAgo === 0` and the backward control at `weeksAgo === 12` rather than clamping silently (FR-001, FR-002, FR-003)
- [X] T011 [US1] In `apps/web/features/dashboard/weekly-workouts.tsx`, derive the request window as `after = week start`, `before = week start + 7 days` — derived from the start, never from the Sunday `end`, which would drop every workout performed on the week's final day (FR-005, data-model.md → TrainingWeek)
- [X] T012 [US1] In `apps/web/features/dashboard/weekly-workouts.tsx`, send an explicit `limit=100` on the week request; without it the API applies `DEFAULT_LIMIT = 20` and a busy week silently loses its 21st workout (FR-007, research #4)
- [X] T013 [P] [US1] In `apps/web/features/dashboard/volume-chart.tsx`, scope the volume request to the selected week's ISO key via `weekKeyForOffset`, so the chart and the list always describe the same week (FR-004)
- [X] T014 [US1] Render the weekly list in `apps/web/features/dashboard/weekly-workouts.tsx` through the shared `WorkoutTable` from T008, removing the duplicated row markup (FR-024)
- [X] T015 [P] [US1] Fix the copy in `apps/web/features/dashboard/weekly-workouts.tsx`: the error message reads "Could not load your weekly volume" and the empty state reads "matched workouts show up here a moment after parsing" — both were copied from the volume chart and describe the wrong panel (FR-008)
- [X] T016 [US1] Ensure both dashboard panels distinguish loading, empty, and failed states, with the failed state offering a retry that preserves the selected week rather than resetting to the current one (FR-008, contracts/ui-routes.md → Panel states)

**Checkpoint**: The dashboard reviews any of the last 12 weeks; quickstart.md Scenarios 1, 2 and 6 pass

---

## Phase 4: User Story 2 - Log a workout from anywhere and see it land (Priority: P2)

**Goal**: Logging is reachable from every signed-in screen, and a logged workout appears on screen without a reload — pulling the dashboard to its week when it belongs to a different one

**Independent Test**: quickstart.md Scenarios 3 and 4 — log from `/workouts` and see the row appear without reloading; step back two weeks on the dashboard, log a workout dated today, and watch the dashboard move to today's week.

**Depends on**: T009 (the store)

- [X] T017 [US2] In `apps/web/components/log-workout-form.tsx`, publish to the T009 store after `POST /workouts` succeeds — incrementing `revision` and setting `lastPerformedAt` to the workout's performed date; publish exactly once, and never on validation failure, network error, or dismissal (FR-011, contracts/ui-routes.md → Producer)
- [X] T018 [P] [US2] In `apps/web/features/workouts/workout-list.tsx`, subscribe to `revision` and refetch the current page when it changes (FR-011)
- [X] T019 [P] [US2] In `apps/web/features/dashboard/weekly-workouts.tsx`, subscribe to `revision` and refetch the selected week when it changes (FR-011)
- [X] T020 [P] [US2] In `apps/web/features/dashboard/volume-chart.tsx`, subscribe to `revision` and refetch the selected week when it changes — a logged workout changes that week's volume once parsed (FR-011)
- [X] T021 [US2] In `apps/web/features/dashboard/dashboard.tsx`, on a `revision` change compare `lastPerformedAt`'s ISO week against the week on screen and switch `weeksAgo` to that workout's week when they differ; the week must change *before* the panels refetch, so a cross-week log costs one fetch per panel rather than two (FR-012, contracts/ui-routes.md → Ordering)
- [X] T022 [P] [US2] Confirm `apps/web/components/log-workout-button.tsx` renders nothing for a visitor without a session, so the logging action is offered only when signed in (FR-014)
- [X] T023 [P] [US2] Confirm the logging modal in `apps/web/components/log-workout-button.tsx` closes without submitting on the close control, Escape, and a backdrop click, and that the form is mounted only while open so its contents and object URLs are discarded each time (FR-010)

**Checkpoint**: Logging feeds back into whatever is on screen; quickstart.md Scenarios 3 and 4 pass

---

## Phase 5: User Story 3 - Move around the signed-in app (Priority: P3)

**Goal**: Consistent chrome on every signed-in screen, working navigation, and correct routing for signed-in and signed-out visitors

**Independent Test**: quickstart.md Scenario 7 — move between dashboard and history using only the sidebar with no full page reload, sign out, sign back in, and open a signed-in screen with cleared storage.

**Depends on**: T003–T005 (the layouts these components sit in)

- [X] T024 [P] [US3] In `apps/web/components/header/header.tsx`, render the app name linking to `/`, plus the logging action and sign-out when signed in; sign-out clears the token store and navigates to `/login` (FR-015, FR-019)
- [X] T025 [P] [US3] In `apps/web/components/sidebar/sidebar.tsx`, render navigation to `/dashboard` and `/workouts` marking the current section with `aria-current="page"` (FR-016)
- [X] T026 [US3] In `apps/web/app/(main)/page.tsx`, route `/` to `/dashboard` when a session exists and `/login` when it does not, reading the token store directly so a refresh does not flash through `/login` before the external store re-syncs (FR-017)
- [X] T027 [US3] Confirm every signed-in screen (`apps/web/features/dashboard/dashboard.tsx`, `apps/web/features/workouts/workout-list.tsx`, `apps/web/features/workouts/workout-detail.tsx`) gates on `useRequireAuth` and renders nothing until the check resolves, so no personal data paints before a redirect (FR-018)
- [ ] T028 [US3] Confirm that clearing the session in another tab stops the open tab from showing personal data, via the `storage` event subscription in `apps/web/hooks/use-require-auth.ts` (spec.md → Edge Cases)
- [X] T029 [US3] Confirm signed-out screens offer neither the logging action nor sign-out, per the `(auth)` layout's `showLogout={false}` and T022's authentication gate (FR-020)

**Checkpoint**: quickstart.md Scenario 7 passes, including no full document load on sign-in or sign-out

---

## Phase 6: User Story 4 - Browse the complete history without losing entries (Priority: P3)

**Goal**: Paging through the full workout history never skips or duplicates a row, including when consecutive workouts share an identical `performed_at`

**Independent Test**: quickstart.md Scenario 5 — create 25 workouts on one date, page all the way forward, and confirm each appears exactly once.

> **Revised 2026-09-08.** T030–T036 originally specified a composite keyset cursor (`before_id`). After the failure was reproduced against Postgres and the options compared, the approach changed to a total ordering plus shared offset pagination in one envelope — see research #2 and #11, and contracts/api-delta.md. The tasks below are the revised set.

### Contract tests for User Story 4 ⚠️

> Write these first and confirm they FAIL before the implementation tasks below.

- [X] T030 [US4] Add contract tests to `apps/api/tests/contract/workouts.list.spec.ts`, matching the file's existing style: (a) rows sharing one `performed_at` come back in `id DESC` order and in the same order on a repeated request; (b) paging with `per_page=2` over 7 workouts, 5 sharing a `performed_at`, visits every row exactly once; (c) the envelope defaults to `page: 1`, `per_page: 20`, `prev_page: null`; (d) a page past the end returns `data: []` with `next_page: null` and status 200; (e) `per_page=101`, `page=0` and the retired `limit=5` each → 400 — see contracts/api-delta.md

### Implementation for User Story 4

- [X] T031 [US4] Add `apps/api/src/common/pagination.dto.ts` (`PaginationQueryDto` with `page` ≥ 1 default 1, and `per_page` 1–100 default 20) and `apps/api/src/common/pagination.ts` (`Paginated<T>` plus a `paginate()` helper that applies skip/take, runs `getManyAndCount()` and builds the envelope). A base DTO rather than a `@Pagination()` decorator, so the global ValidationPipe keeps doing the parsing and validation (research #11)
- [X] T032 [US4] In `apps/api/src/workouts/dto/list-workouts-query.dto.ts`, extend `PaginationQueryDto` and drop `limit`; in `apps/api/src/workouts/workouts.service.ts`, append `id DESC` to the ordering so it is a total order, and return `paginate(qb, query, map)` instead of a bare `{ workouts }` (FR-022, research #2)
- [X] T033 [P] [US4] In `packages/shared/src/entities/workout.entity.ts`, extend the `@Index(['userId', 'performedAt'])` decorator to carry `'id'`, so the index satisfies the new total ordering (data-model.md §1)
- [X] T034 [US4] Add a migration under `packages/shared/src/db/migrations/` replacing index `IDX_e6a14b328d153b3050dd0773af` on `("user_id", "performed_at")` with one on `("user_id", "performed_at" DESC, "id" DESC)`, with a `down` that restores the two-column form; trim any unrelated statements `migration:generate` emits, as prior migrations in this directory document (research #3)
- [X] T035 [US4] Fold the pagination envelope, the `page`/`per_page` params and the ordering rule from contracts/api-delta.md into `specs/001-workout-logging-mvp/contracts/api.md`, which remains the single authoritative contract
- [X] T036 [US4] In `apps/web/features/workouts/workout-list.tsx`, replace the cursor stack with a single `page` integer driven by the response's `next_page`/`prev_page`, and drop the over-fetch-by-one trick now that `total` and `next_page` are returned; add `Paginated<T>` to `apps/web/lib/pagination.ts` and `page`/`per_page` to `listWorkouts` in `apps/web/services/workouts.ts` (FR-022, data-model.md → Page position)
- [X] T037 [US4] Render the history list in `apps/web/features/workouts/workout-list.tsx` through the shared `WorkoutTable` from T008, removing the duplicated row markup (FR-024)
- [X] T038 [P] [US4] Confirm the paging controls in `apps/web/features/workouts/workout-list.tsx` are disabled on the first page and when no further page exists (FR-023)

**Checkpoint**: quickstart.md Scenario 5 passes and `npm run test --workspace=apps/api` is green

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T039 [P] In `apps/web/features/workouts/workout-detail.tsx`, clear the previously loaded workout when `id` changes, so switching between workouts does not briefly show the previous one's data
- [ ] T040 [P] Add a final newline to `apps/web/app/(main)/dashboard/page.tsx`, `apps/web/features/dashboard/dashboard.tsx`, and `apps/web/features/dashboard/weekly-workouts.tsx`, and convert their double-quoted imports to single quotes, matching the repository's `.editorconfig` and the surrounding files
- [ ] T041 Run the static checks from quickstart.md and confirm all three are clean and the build still prerenders all five routes: `npx tsc --noEmit -p apps/web/tsconfig.json`, `npm run lint --workspace=@workout-logging/web`, `npm run build --workspace=@workout-logging/web`
- [ ] T042 Run `npm run test --workspaces --if-present` and confirm spec 001 and 002 behaviour is intact
- [ ] T043 Walk every scenario in [quickstart.md](./quickstart.md) — Scenarios 3, 4 and 5 cover the requirements no automated test in this project reaches (research #10)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — T001 and T002 can start immediately
- **Foundational (Phase 2)**: Blocks every user story. T003→T004→T005 are sequential (same layout restructure); T006→T007 are sequential (the move must precede the import normalization); T008 and T009 are independent of both
- **User Stories (Phases 3–6)**: All depend on Phase 2. US1, US2, US3 and US4 are otherwise independent of one another, with one exception noted below
- **Polish (Phase 7)**: T041–T043 depend on every story you intend to ship

### User Story Dependencies

- **US1 (P1)**: Needs T008. No dependency on other stories
- **US2 (P2)**: Needs T009. Its consumer tasks touch files US1 and US4 also touch (`weekly-workouts.tsx`, `volume-chart.tsx`, `workout-list.tsx`), so if US1/US2 are worked in parallel, sequence the edits to those three files
- **US3 (P3)**: Needs T003–T006. No dependency on other stories
- **US4 (P3)**: Needs T008. The API half (T030–T035) is independent of all web work and can proceed entirely in parallel with US1–US3

### Within Each User Story

- Contract tests (T030) before the implementation they cover
- API before the client that calls it: T031/T032 before T036
- Shared component before its consumers: T008 before T014 and T037

### Parallel Opportunities

- T001 and T002 together
- T008 and T009 together, and both alongside T003–T007
- T013 and T015 within US1
- T018, T019 and T020 within US2 — three different files, same subscription pattern
- T024 and T025 within US3
- T033 and T038 within US4
- The whole of US4's API work (T030–T035) alongside all of US1–US3
- T039 and T040 together

---

## Parallel Example: Phase 2 Foundational

```bash
# The layout collapse and the alias work are separate file sets:
Task: "Create the single root layout in apps/web/app/layout.tsx"          # T003
Task: "Create components/workout-table.tsx"                                # T008
Task: "Create services/workout-events.ts"                                  # T009
```

## Parallel Example: User Story 2

```bash
# Three consumers of the same store, three different files:
Task: "Subscribe workout-list.tsx to revision"                             # T018
Task: "Subscribe weekly-workouts.tsx to revision"                          # T019
Task: "Subscribe volume-chart.tsx to revision"                             # T020
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Phase 1 (Setup) → Phase 2 (Foundational)
2. Phase 3 (US1)
3. **STOP and VALIDATE**: quickstart.md Scenarios 1, 2 and 6
4. At this point the dashboard reviews weeks — the feature's actual product value

### Incremental Delivery

1. Setup + Foundational → structure corrected, shared modules in place
2. US1 → week review works → validate → **MVP**
3. US2 → logging feeds back into the screen → validate Scenarios 3 and 4
4. US4 → history stops losing rows → validate Scenario 5 and the contract tests
5. US3 → shell and navigation confirmed → validate Scenario 7

US4 is placed before US3 in this order deliberately: it is the only remaining
*correctness* work, while US3 is largely confirmation of behaviour that
already exists.

### Solo Sequencing Note

This project has one developer, so the "parallel team" split does not apply.
The parallel markers above are still useful as batching hints — grouping
independent edits into one pass rather than as concurrent assignments.

---

## Notes

- `[P]` marks different files with no incomplete dependencies
- `[Story]` labels map tasks to spec.md user stories for traceability
- FR references point at [spec.md](./spec.md); `research #N` at [research.md](./research.md)
- Several tasks read "Confirm ..." rather than "Implement ..." — those describe behaviour believed already present, kept as tasks so the requirement is verified rather than assumed
- FR-013 has no task by design: reflecting a workout's later `pending → parsed` transition on an open screen is explicitly out of scope and deferred to its own spec
- Commit after each task or logical group; stop at any checkpoint to validate a story on its own

---

## Phase 8: Convergence

Appended by `/speckit-converge` on 2026-09-08. These are gaps found by
assessing the codebase against spec.md, plan.md, and research.md that **no
existing task above already covers**. The bulk of this feature's remaining
work is Phases 1–7, which are still unchecked — converge deliberately did
not duplicate them.

T044 and T045 share one root cause: the token store in
`apps/web/services/api-client.ts` holds an in-memory cache that is never
invalidated after first hydration and notifies no one when it changes.
Fixing that store resolves both.

- [X] T044 Make the token store in `apps/web/services/api-client.ts` observable: notify subscribers when `saveTokens`/`clearTokens` run, and re-read `localStorage` on a `storage` event instead of returning the memoized `tokensCache` — `hydrateFromStorage()` returns early once `hydrated` is true, so `loadTokens()` never sees another tab's sign-out, and the `storage` subscription in `use-require-auth.ts` observes an unchanged snapshot; signing out in one tab currently leaves the other tab signed in and showing personal data, per spec.md Edge Cases and SC-006 (contradicts)
- [X] T045 Route the user to `/login` when token refresh fails: `apiFetch` in `apps/web/services/api-client.ts` calls `clearTokens()` and returns the 401 to the caller, which renders "Could not load…" with a Retry that can only keep failing — no navigation happens, and no same-tab notification reaches `useRequireAuth`, so an expired session becomes exactly the dead end spec.md Edge Cases forbids ("never a silent failure or an infinite retry"); depends on T044 (missing)
- [ ] T046 Refetch the weekly volume when a workout is deleted from the weekly list in `apps/web/features/dashboard/weekly-workouts.tsx` — `remove()` updates only its own rows, so `VolumeChart` keeps counting the deleted workout and the two panels stop agreeing about the same week, per FR-004 and spec.md Edge Cases; reuse the T009 store rather than adding a second signalling path (partial)
- [ ] T047 Gate the sign-out control in `apps/web/components/header/header.tsx` on `useIsAuthenticated()` rather than the `showLogout` prop — `/` lives in the `(main)` group whose layout renders `<Header />` with `showLogout` defaulting to true, so a signed-out visitor landing on `/` is offered "Log out" for as long as the redirect takes, per FR-020 and SC-006 (partial)
