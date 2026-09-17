# UI Contract: Routes, Chrome, and the Logged-Workout Signal

**Feature**: 003-web-shell-weekly-dashboard | **Date**: 2026-09-08

`apps/web` ships as a static export, so its "interface" is a route map plus
the chrome each route sits inside — there is no server-rendered contract to
document. This file states both, and the one internal contract that crosses
component boundaries: how a newly logged workout reaches whatever is on
screen.

## Route map

Five routes, all statically prerendered.

| Path | Group | Auth | Renders |
| --- | --- | --- | --- |
| `/` | `(main)` | either | Nothing. Redirects to `/dashboard` with a session, `/login` without (FR-017) |
| `/login` | `(auth)` | signed out | Sign-in form |
| `/register` | `(auth)` | signed out | Registration form |
| `/dashboard` | `(main)` | required | Week selector + volume chart + that week's workouts |
| `/workouts` | `(main)` | required | Full history, paged. With `?id=<uuid>`, one workout's detail |

`/workouts` carries the detail view as a query parameter rather than a
dynamic segment because a static export cannot prerender an unknown
`/workouts/[id]`. The page reads the parameter inside a Suspense boundary,
which the export requires.

## Layout contract

One root layout, two nested group layouts (research #5):

```
app/layout.tsx            <html>, <body>, fonts, metadata      — every route
├── (auth)/layout.tsx     Header without sign-out               — /login, /register
└── (main)/layout.tsx     Header + Sidebar                      — /, /dashboard, /workouts
```

**Root layout** declares the document exactly once. No group layout may
render `<html>` or `<body>` — that is what made sign-in and sign-out cost a
full document load.

**Header**, on every route: the app name linking to `/`. Signed in, it also
carries the log-workout action and sign-out (FR-015). Signed out, it carries
neither (FR-020).

**Sidebar**, on `(main)` only: navigation to `/dashboard` and `/workouts`,
with the current section marked via `aria-current="page"` (FR-016).

## Auth behaviour

| Situation | Required behaviour | Requirement |
| --- | --- | --- |
| Signed-in screen opened without a session | Redirect to `/login`; no personal data rendered at any point, including during hydration | FR-018 |
| `/` opened with a valid session | Arrive at `/dashboard` without the login screen appearing first | FR-017 |
| Sign-out | Session discarded, then `/login` | FR-019 |
| Successful sign-in | Arrive at `/dashboard` | User Story 3, scenario 5 |
| Session cleared in another tab | Open tab stops showing personal data | Edge case |

The redirect decision reads the token store directly rather than the
subscribed value, because during hydration the external store serves its
server snapshot (no session) and only syncs a tick later — keying off the
subscribed value bounces every refresh through `/login`. This is existing
behaviour in `use-require-auth.ts` and must survive the move to `hooks/`.

## Logged-workout signal

The internal contract between the header's logging form and every list.
Module: `services/workout-events.ts`. Read through `useSyncExternalStore`.

**Published state**

| Field | Type | Meaning |
| --- | --- | --- |
| `revision` | integer | Increments once per successful log |
| `lastPerformedAt` | ISO string \| null | Performed date of the workout just logged |

**Producer.** `LogWorkoutForm` publishes exactly once, after `POST /workouts`
succeeds — never on validation failure, never on a network error, never on
dismissal.

**Consumers**

| Consumer | Obligation |
| --- | --- |
| History list (`/workouts`) | Refetch the current page when `revision` changes (FR-011) |
| Weekly list (dashboard) | Refetch the selected week when `revision` changes (FR-011) |
| Volume chart (dashboard) | Refetch the selected week when `revision` changes — a logged workout can change the week's volume once parsed |
| Dashboard week selector | On a `revision` change, if `lastPerformedAt` falls in a different week than the one shown, switch to that workout's week (FR-012) |

**Ordering.** The dashboard changes week *before* its panels refetch, so a
cross-week log costs one fetch per panel, not two.

**Out of scope by contract.** The signal carries newly logged workouts only.
The later `pending → parsed` transition produced by the worker is **not**
delivered here and is not required to appear without a reload (FR-013). No
consumer should poll this store hoping to observe it.

## State contract

| State | Owner | Notes |
| --- | --- | --- |
| Selected week (`weeksAgo`, 0–12) | Dashboard component | Not in the URL; a reload returns to the current week |
| History page cursor stack | History list component | Not in the URL; a reload returns to page 1 |
| Open/closed logging modal | Header button | Form is mounted only while open, so it starts empty each time and its object URLs are released |
| Session tokens | `services/api-client.ts` | localStorage, unchanged from spec 001 |

Week and page are deliberately component state rather than URL parameters:
this feature does not promise shareable or restorable views, and adding them
to the URL would mean a static export handling arbitrary query
combinations. If deep-linking to a week is wanted later, it is an additive
change.

## Panel states

Every data panel (volume chart, weekly list, history list, workout detail)
distinguishes four states, and no panel may show a blank area instead
(FR-008):

- **Loading** — an explicit indicator.
- **Empty** — a sentence saying the week or list is empty, not an error.
- **Failed** — the reason plus a retry control that preserves the selected
  week or page.
- **Loaded** — the data.
