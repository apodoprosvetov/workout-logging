@AGENTS.md

# File layout

**One React component per file.** Two are allowed only when:

- Next forces it — a `page.tsx` whose `Suspense` boundary wraps its own content,
  because `useSearchParams` under `output: 'export'` needs the boundary; or
- the second is a private row rendered only by the first and short enough to
  read without scrolling (`in-flight-panel.tsx` is the precedent, ~20 lines).

Anything past that becomes a folder. A feature that outgrows one file:

```
features/<area>/<feature>/
  index.ts             re-exports the entry component, nothing else
  <feature>.tsx        the screen: state, effects, layout
  <row>.tsx            one component each
  lib/                 the feature's non-component modules, with their specs
```

`features/workouts/edit-form/` is the worked example.

**A module with one consumer lives with that consumer.** App-level `lib/` is for
what two or more features import (`lib/weeks.ts`, `lib/display/`,
`lib/contracts/`). A helper only the edit form uses belongs in
`features/workouts/edit-form/lib/`, even when it is pure and testable — being
pure is not what earns a module a place in the shared folder.

**Why this is a rule and not a preference:** `workout-edit-form.tsx` reached 559
lines holding four components and five helpers while the next largest file in the
same folder was 216. Nothing in it was wrong; it was simply unreadable as one
file, and the split cost nothing because each piece already had clean seams.

# Testing

`vitest` runs in `node`, with no jsdom — by an explicit earlier decision, nothing
renders a component in a test. So the logic worth testing has to sit in plain
modules (`lib/`, `services/`, a feature's own `lib/`), and components stay thin
enough that reading them is the review. Component behaviour is verified in a real
browser instead.
