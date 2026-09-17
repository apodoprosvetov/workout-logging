'use client';

import { useCallback, useState } from 'react';

import { InFlightPanel, useInFlight } from '@features/in-flight';
import { LogWorkoutForm } from '@features/log-workout';

import { Modal } from './modal';

// The header's two workout controls, and the host for the surfaces they open.
//
// MUST only ever be mounted for a signed-in visitor. It does not check the
// session itself — Header does, and renders this only behind that check. The
// guard has to be the caller's rather than an early `return null` here, because
// `useInFlight` below runs before any such return could: hooks cannot sit under
// a condition, so a self-gating version still fetches `/workouts` and opens the
// `/api/events` stream on the login page, both answering 401 on repeat. That
// was measured, and moving the guard to Header is what fixed it — do not "tidy
// up" Header's `{authenticated && ...}` as redundant.
//
// This file is in components/ because it is chrome — it appears on every page
// the visitor is signed in for. The two surfaces it opens are not, and live
// under features/: each has exactly this one caller, so neither is shared by
// the standard components/ applies.
// What it keeps here is the trigger and the open/closed state, nothing else —
// the dialog mechanics belong to Modal, the panels to their features.
//
// Both surfaces live here because FR-011 puts the in-flight surface "wherever
// the logging action appears", and this component is that place. They are two
// separate <Modal> elements rather than one with two panes, which is what keeps
// FR-021 (and T034) satisfiable by construction: opening, closing or refetching
// the in-flight surface cannot remount LogWorkoutForm, because the form is not
// in its tree. A shared host would put a half-filled form one re-render away
// from being discarded. Verified in Chrome against a real notification.
export function LogWorkoutButton() {
  const [logOpen, setLogOpen] = useState(false);
  const [inFlightOpen, setInFlightOpen] = useState(false);

  const { items, loading, error, count, reload, remove } = useInFlight();

  const closeLog = useCallback(() => setLogOpen(false), []);
  const closeInFlight = useCallback(() => setInFlightOpen(false), []);

  return (
    <>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setLogOpen(true)}
          className="rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
        >
          Log workout
        </button>

        {/* FR-013: while the surface is closed, the control that opens it says
            how many workouts are in flight — otherwise closing the modal is
            what makes in-progress work invisible, which is the failure this
            whole surface exists to prevent. Always rendered, never hidden at
            zero: the surface must also be reachable to state plainly that
            nothing is in progress (FR-015), and a control that disappears at
            zero cannot be pressed to learn that. */}
        <button
          type="button"
          onClick={() => setInFlightOpen(true)}
          aria-label={count === 0 ? 'Nothing in progress' : `${count} in progress — open the list`}
          className="rounded-full border border-zinc-300 px-3 py-2 text-sm font-medium tabular-nums text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          {count === 0 ? '⏳' : `⏳ ${count}`}
        </button>
      </div>

      <Modal open={logOpen} title="Log a workout" onClose={closeLog}>
        <LogWorkoutForm onLogged={closeLog} />
      </Modal>

      {/* onOpened: the surface fetches on open, so it shows the true current
          state rather than whatever was last pushed — which is what makes it
          useful while the notification channel is down (FR-026). */}
      <Modal open={inFlightOpen} title="In progress" onClose={closeInFlight} onOpened={reload}>
        <InFlightPanel items={items} loading={loading} error={error} onDismiss={remove} />
      </Modal>
    </>
  );
}
