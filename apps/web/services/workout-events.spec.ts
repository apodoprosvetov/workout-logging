import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EventStreamHandlers } from './event-stream';

// Capture what the store hands to startEventStream, so a notification can be
// delivered the way the real channel delivers one — through the wiring, not
// through a test-only export. `publishRemote` stays private precisely because
// nothing but the channel should be able to call it.
const captured: { handlers?: EventStreamHandlers; starts: number; stops: number } = {
  starts: 0,
  stops: 0,
};

vi.mock('./event-stream', () => ({
  startEventStream: (handlers: EventStreamHandlers) => {
    captured.handlers = handlers;
    captured.starts += 1;
    return () => {
      captured.stops += 1;
    };
  },
}));

const {
  getChannelStatus,
  getSnapshot,
  publishWorkoutDeleted,
  publishWorkoutLogged,
  subscribe,
  subscribeToChannelStatus,
} = await import('./workout-events');

/** Opens the channel the way a mounting consumer does, and returns the unsubscribe. */
function mountConsumer(): () => void {
  return subscribe(() => {});
}

/**
 * Delivers a notification through the captured handler.
 *
 * The date is a parameter and defaults to something distinct from the one the
 * local-publish tests use: since T032 the store carries the notification's own
 * `performed_at`, so a shared constant would let a test pass while the store
 * read the wrong field.
 */
function deliverRemote(
  performedAt = '2026-09-14T00:00:00.000Z',
  { workoutId = 'w1', status = 'parsed' }: { workoutId?: string; status?: string } = {},
): void {
  captured.handlers?.onNotification({
    type: 'workout.settled',
    event_id: 'evt-1',
    user_id: 'u1',
    occurred_at: '2026-09-14T00:00:00.000Z',
    workout_id: workoutId,
    status,
    performed_at: performedAt,
  } as never);
}

/** `analytics.updated` is the one kind with no `performed_at` — it names a week instead. */
function deliverRemoteAnalytics(): void {
  captured.handlers?.onNotification({
    type: 'analytics.updated',
    event_id: 'evt-2',
    user_id: 'u1',
    occurred_at: '2026-09-14T00:00:00.000Z',
    iso_week: '2026-W37',
  } as never);
}

// The store is a module singleton, so `revision` accumulates across this file.
// Every assertion below is therefore about *deltas* and *relative* order, never
// absolute counter values — which is also how the consumers read it.
describe('workout-events store', () => {
  let unsubscribe: () => void;

  beforeEach(() => {
    unsubscribe?.();
    unsubscribe = mountConsumer();
  });

  // Without this the last test's subscription outlives the block, and since the
  // store is a module singleton its listener count never returns to zero — the
  // channel stays open for every later suite in this file, which is exactly
  // what the status tests below need to be able to close.
  afterAll(() => {
    unsubscribe?.();
  });

  describe('convergence (FR-020)', () => {
    it('is unaffected by the same notification arriving twice', () => {
      // Since T032 this is no longer true by construction: the snapshot carries
      // the notification's type and date, so a repeat could in principle land
      // somewhere different. It does not, because applying a notification
      // overwrites rather than accumulates — and that is now worth asserting
      // rather than assuming.
      deliverRemote();
      const once = getSnapshot();

      deliverRemote();
      const twice = getSnapshot();

      expect(twice.performedAt).toBe(once.performedAt);
      expect(twice.origin).toBe(once.origin);
      expect(twice.changeType).toBe(once.changeType);
    });

    it('reaches the same state whichever order two notifications arrive in', () => {
      // Two *different* notifications, so order could matter if the store
      // merged rather than replaced. The last one wins either way, and the
      // pair is applied in both orders to show the end state is the same.
      const settled = '2026-09-14T00:00:00.000Z';

      deliverRemote(settled);
      deliverRemoteAnalytics();
      const afterAB = getSnapshot();

      deliverRemoteAnalytics();
      deliverRemote(settled);
      const afterBA = getSnapshot();

      // Each ends on whichever arrived last — the property is that replaying
      // the same pair reproduces the same state, not that the two orders agree.
      expect(afterAB.changeType).toBe('analytics.updated');
      expect(afterAB.performedAt).toBeNull();
      expect(afterBA.changeType).toBe('workout.settled');
      expect(afterBA.performedAt).toBe(settled);

      deliverRemoteAnalytics();
      deliverRemote(settled);
      expect(getSnapshot().changeType).toBe(afterBA.changeType);
      expect(getSnapshot().performedAt).toBe(afterBA.performedAt);
    });

    it('moves the revision forward on every change and never backwards', () => {
      // Consumers keep `revision` in their effect dependencies; a counter that
      // repeated or went backwards would make a refetch silently not happen.
      const seen: number[] = [getSnapshot().revision];

      deliverRemote();
      seen.push(getSnapshot().revision);
      publishWorkoutDeleted();
      seen.push(getSnapshot().revision);
      publishWorkoutLogged('w-local', '2026-09-07T00:00:00.000Z');
      seen.push(getSnapshot().revision);

      for (let i = 1; i < seen.length; i++) {
        expect(seen[i]).toBeGreaterThan(seen[i - 1]);
      }
    });

    it('hands out a stable snapshot reference between changes', () => {
      // useSyncExternalStore compares by reference on every render: a fresh
      // object from getSnapshot with no change behind it re-renders forever.
      const a = getSnapshot();
      const b = getSnapshot();
      expect(a).toBe(b);

      deliverRemote();
      expect(getSnapshot()).not.toBe(a);
    });
  });

  describe('local and remote changes are distinguishable', () => {
    it('marks a locally logged workout local, with its date', () => {
      publishWorkoutLogged('w-local', '2026-09-07T00:00:00.000Z');

      const s = getSnapshot();
      expect(s.origin).toBe('local');
      expect(s.performedAt).toBe('2026-09-07T00:00:00.000Z');
      // A local change is not a notification and has no type to report.
      expect(s.changeType).toBeNull();
    });

    it('marks a change from the channel remote, and carries its date', () => {
      // The date is kept rather than blanked (T032). A week-scoped list cannot
      // honour FR-019 without it — it has to know which week moved. What stops
      // the dashboard from *navigating* on this is the origin being `remote`
      // rather than `own-workout`, not a missing date.
      deliverRemote('2026-09-14T00:00:00.000Z');

      const s = getSnapshot();
      expect(s.origin).toBe('remote');
      expect(s.performedAt).toBe('2026-09-14T00:00:00.000Z');
      expect(s.changeType).toBe('workout.settled');
    });

    it('reports no date for analytics.updated, which names a week instead', () => {
      deliverRemoteAnalytics();

      const s = getSnapshot();
      expect(s.changeType).toBe('analytics.updated');
      expect(s.performedAt).toBeNull();
    });

    it('leaves the date null after a deletion', () => {
      // Deleting must refresh the week on screen, never navigate away from it.
      publishWorkoutLogged('w-local', '2026-09-07T00:00:00.000Z');
      publishWorkoutDeleted();

      const s = getSnapshot();
      expect(s.origin).toBe('local');
      expect(s.performedAt).toBeNull();
    });

    it('names the week a workout notification lands in, derived from its date', () => {
      // Derived here rather than taken from a second server field, so the week
      // this reports and the week the dashboard renders cannot disagree — both
      // come from lib/weeks.ts (FR-010, SC-004).
      deliverRemote('2026-06-10T00:00:00.000Z');

      expect(getSnapshot().isoWeek).toBe('2026-W24');
    });

    it("takes analytics.updated's own week, which carries no date to derive one from", () => {
      // The case that was silently broken: with the week read only from
      // `performed_at`, this kind reported null, null means "may concern any
      // week", and the volume chart refetched every recomputation — measured
      // against one seventeen weeks away from the week on screen.
      deliverRemoteAnalytics();

      const s = getSnapshot();
      expect(s.performedAt).toBeNull();
      expect(s.isoWeek).toBe('2026-W37');
    });

    it('names the week for a local log too', () => {
      // Local and remote have to be comparable: the weekly list applies one
      // filter to both, so a local log that reported no week would refetch
      // every week-scoped panel on screen regardless of where it landed.
      publishWorkoutLogged('w-local', '2026-09-16T00:00:00.000Z');

      expect(getSnapshot().isoWeek).toBe('2026-W38');
    });

    it('reports no week for a deletion, which names none', () => {
      // Read as "may concern any week" by a week-scoped list, which is what it
      // must do — the workout that went may well have been the one on screen.
      // The dashboard reads the same null the opposite way and stays put.
      publishWorkoutDeleted();

      expect(getSnapshot().isoWeek).toBeNull();
    });

    it('does not let the echo of our own log look like a local change', () => {
      // The race T020 recorded, now resolved — this is its regression test.
      //
      // Once T038 publishes workout.created, every local log is followed
      // milliseconds later by our own POST coming back over our own channel.
      // The store used to blank the date on any remote change, so the dashboard
      // saw the revision move with the date gone and skipped the week switch.
      //
      // Nothing is blanked now. The echo overwrites the snapshot and keeps the
      // date, and what decides whether anyone acts on it is the origin — which
      // is about the workout, not about the date. The settle below names a
      // different workout, so it is somebody else's and stays `remote`; the
      // FR-018 block covers the case where the id does match.
      publishWorkoutLogged('w-echo', '2026-09-07T00:00:00.000Z');
      expect(getSnapshot().origin).toBe('local');
      expect(getSnapshot().performedAt).toBe('2026-09-07T00:00:00.000Z');

      deliverRemote('2026-09-07T00:00:00.000Z', { workoutId: 'w-someone-else' });

      const echoed = getSnapshot();
      expect(echoed.origin).toBe('remote');
      // The date survives rather than being destroyed — destroying it was the
      // bug, and nothing needs it gone to behave correctly.
      expect(echoed.performedAt).toBe('2026-09-07T00:00:00.000Z');
    });
  });

  describe('channel lifetime', () => {
    it('does not start a second stream when another consumer mounts', () => {
      // Counted rather than checked for presence: by now a channel is already
      // open from beforeEach, and the property under test is that mounting
      // more consumers adds no streams — two would deliver every notification
      // twice and hold two sockets for one user.
      const before = captured.starts;

      const second = subscribe(() => {});
      const third = subscribe(() => {});

      expect(captured.starts).toBe(before);

      second();
      third();
    });

    it('notifies every mounted consumer', () => {
      const calls: string[] = [];
      const a = subscribe(() => calls.push('a'));
      const b = subscribe(() => calls.push('b'));

      deliverRemote();

      expect(calls).toContain('a');
      expect(calls).toContain('b');
      a();
      b();
    });
  });

  // contracts/ui.md, "The one permitted navigation". The store answers the
  // first two conditions — it is the only thing that knows which workouts this
  // tab created, and it reads the settle's status. The third (a different week)
  // belongs to the dashboard, which is the only thing that knows what is on
  // screen, and cannot be reached from here without a DOM.
  //
  // Ids are unique per test on purpose: the store is a module singleton, so the
  // set of "logged here" ids carries across the whole file.
  describe('FR-018: only this session may follow its own workout', () => {
    it('recognises a settle for a workout this tab logged', () => {
      publishWorkoutLogged('w-mine', '2026-09-07T00:00:00.000Z');
      // Submitting is not settling — `local`, not `own-workout`. The dashboard
      // must not move yet: the parser may still change the date it would
      // navigate to.
      expect(getSnapshot().origin).toBe('local');

      deliverRemote('2026-09-09T00:00:00.000Z', { workoutId: 'w-mine' });

      const s = getSnapshot();
      expect(s.origin).toBe('own-workout');
      expect(s.settledStatus).toBe('parsed');
      // The date comes from the settle, not from the submission — this is the
      // whole reason the navigation waits for it.
      expect(s.performedAt).toBe('2026-09-09T00:00:00.000Z');
    });

    it('does not claim a workout logged on another tab or device', () => {
      // US3 scenario 3. Nothing was published here for this id, so the settle
      // is somebody else's and must not move this screen.
      deliverRemote('2026-09-09T00:00:00.000Z', { workoutId: 'w-somewhere-else' });

      expect(getSnapshot().origin).toBe('remote');
    });

    it('reports the status a settle carried, so `failed` can be refused', () => {
      publishWorkoutLogged('w-failed', '2026-09-07T00:00:00.000Z');

      deliverRemote('2026-09-07T00:00:00.000Z', { workoutId: 'w-failed', status: 'failed' });

      const s = getSnapshot();
      // Ours, but not navigable — it stays in the in-flight surface until
      // dismissed (FR-014). Refusing it is the dashboard's call, and this is
      // the fact it refuses on.
      expect(s.origin).toBe('own-workout');
      expect(s.settledStatus).toBe('failed');
    });

    it('reports no status for a change that is not a settle', () => {
      deliverRemoteAnalytics();

      expect(getSnapshot().settledStatus).toBeNull();
    });

    it('forgets a workout once it has settled, however it settled', () => {
      // Two reasons this matters. The set would otherwise grow for the life of
      // the tab; and a redelivered settle would navigate a second time, long
      // after the user moved somewhere else — FR-020 asks that repeats leave
      // the same state, and a second navigation is not the same state.
      publishWorkoutLogged('w-once', '2026-09-07T00:00:00.000Z');

      deliverRemote('2026-09-07T00:00:00.000Z', { workoutId: 'w-once' });
      expect(getSnapshot().origin).toBe('own-workout');

      deliverRemote('2026-09-07T00:00:00.000Z', { workoutId: 'w-once' });
      expect(getSnapshot().origin).toBe('remote');
    });

    it('forgets a workout that settled to failed too', () => {
      // The failure path must clear the id as surely as the success path: a
      // workout logged again after failing gets a new id, so keeping the old
      // one only leaves something behind that can never match.
      publishWorkoutLogged('w-gone', '2026-09-07T00:00:00.000Z');

      deliverRemote('2026-09-07T00:00:00.000Z', { workoutId: 'w-gone', status: 'failed' });
      expect(getSnapshot().origin).toBe('own-workout');

      deliverRemote('2026-09-07T00:00:00.000Z', { workoutId: 'w-gone', status: 'failed' });
      expect(getSnapshot().origin).toBe('remote');
    });
  });
});

// The status half of this module. Exercised through the captured handlers the
// same way notifications are, so what is tested is the wiring the app actually
// runs — `setChannelStatus` is private for the same reason `publishRemote` is.
describe('channel status (FR-025, data-model.md)', () => {
  /** Drives a status change the way the stream does. */
  function deliverStatus(status: 'connecting' | 'live' | 'offline'): void {
    captured.handlers?.onStatus?.(status);
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  /** Tears the channel down and lets the 1s close debounce elapse. */
  function closeChannelAndSettle(unsub: () => void): void {
    unsub();
    vi.advanceTimersByTime(1100);
  }

  it('starts at connecting, not offline', () => {
    // Nothing has failed before the first attempt. Starting at `offline` would
    // tell every user their data is not live at the moment it was fetched.
    const unsub = mountConsumer();

    expect(getChannelStatus()).toBe('connecting');

    closeChannelAndSettle(unsub);
    vi.useRealTimers();
  });

  it('reports what the stream reports', () => {
    const unsub = mountConsumer();

    deliverStatus('live');
    expect(getChannelStatus()).toBe('live');
    deliverStatus('offline');
    expect(getChannelStatus()).toBe('offline');

    closeChannelAndSettle(unsub);
    vi.useRealTimers();
  });

  it('notifies status subscribers', () => {
    const unsub = mountConsumer();
    const seen: string[] = [];
    const unsubStatus = subscribeToChannelStatus(() => seen.push(getChannelStatus()));

    deliverStatus('live');
    deliverStatus('offline');

    expect(seen).toEqual(['live', 'offline']);

    unsubStatus();
    closeChannelAndSettle(unsub);
    vi.useRealTimers();
  });

  it('does not notify twice for the same status', () => {
    const unsub = mountConsumer();
    const listener = vi.fn();
    const unsubStatus = subscribeToChannelStatus(listener);

    deliverStatus('live');
    deliverStatus('live');
    deliverStatus('live');

    // useSyncExternalStore re-renders every subscriber on each notification,
    // so a channel repeating itself would re-render the whole tree for nothing.
    expect(listener).toHaveBeenCalledTimes(1);

    unsubStatus();
    closeChannelAndSettle(unsub);
    vi.useRealTimers();
  });

  it('keeps the two stores separate — status alone refetches nothing', () => {
    const unsub = mountConsumer();
    const before = getSnapshot().revision;
    const dataListener = vi.fn();
    const unsubData = subscribe(dataListener);

    // Reaching `live` for the first time is not a recovery: nothing was missed,
    // and the consumers that just mounted already fetched. This is the whole
    // reason status is a separate store — if every transition moved `revision`,
    // a channel that reconnects several times an hour on token expiry would
    // refetch every mounted list each time it did.
    //
    // The one transition that *does* bump is a recovery after a gap, which is
    // a different claim and has its own block below (FR-023).
    deliverStatus('live');

    expect(getSnapshot().revision).toBe(before);
    expect(dataListener).not.toHaveBeenCalled();

    unsubData();
    closeChannelAndSettle(unsub);
    vi.useRealTimers();
  });

  it('stops claiming live once the channel is torn down', () => {
    // Reachable by signing out on a dashboard with a healthy channel: the
    // socket goes away and, without the reset, the status still reads `live`
    // with nothing behind it — the stale-as-live claim FR-025 forbids.
    const unsub = mountConsumer();
    deliverStatus('live');

    closeChannelAndSettle(unsub);

    expect(getChannelStatus()).toBe('connecting');
    vi.useRealTimers();
  });

  it('keeps reporting live across a navigation', () => {
    // React unmounts the old page's consumers before mounting the new page's,
    // so the count dips to zero on every route change. The stream survives
    // that by design, and the status has to survive it too — resetting on the
    // dip would flash `connecting` on every navigation.
    const unsub = mountConsumer();
    deliverStatus('live');

    unsub();
    const unsubNext = mountConsumer();
    vi.advanceTimersByTime(1100);

    expect(getChannelStatus()).toBe('live');

    closeChannelAndSettle(unsubNext);
    vi.useRealTimers();
  });

  describe('reconnect bump (FR-023)', () => {
    /** Revision delta across a status sequence, and whether it navigated. */
    function bumpsOver(statuses: Array<'connecting' | 'live' | 'offline'>): number {
      const before = getSnapshot().revision;
      for (const s of statuses) deliverStatus(s);
      return getSnapshot().revision - before;
    }

    it('does not bump on the first connection of a page load', () => {
      const unsub = mountConsumer();

      // Nothing was missed: the consumers that just mounted fetched on mount,
      // and the data went on screen moments ago. Bumping here would refetch
      // everything a second time on every single page load.
      expect(bumpsOver(['live'])).toBe(0);

      closeChannelAndSettle(unsub);
      vi.useRealTimers();
    });

    it('bumps when delivery resumes after an outage', () => {
      const unsub = mountConsumer();
      deliverStatus('live');

      expect(bumpsOver(['offline', 'connecting', 'live'])).toBe(1);

      closeChannelAndSettle(unsub);
      vi.useRealTimers();
    });

    it('bumps after a routine token-expiry reconnect', () => {
      const unsub = mountConsumer();
      deliverStatus('live');

      // No `offline` in this path — the server closes a stream whose 15-minute
      // access token expired and the client reopens it, several times an hour.
      // Notifications published in that window are still dropped (FR-027), so
      // a short gap is a gap.
      expect(bumpsOver(['connecting', 'live'])).toBe(1);

      closeChannelAndSettle(unsub);
      vi.useRealTimers();
    });

    it('bumps once per gap, not once per transition', () => {
      const unsub = mountConsumer();
      deliverStatus('live');

      // A long outage flaps: the backoff retries, each attempt reports
      // `connecting` and each failure `offline`. One recovery is one refetch.
      expect(
        bumpsOver([
          'offline',
          'connecting',
          'offline',
          'connecting',
          'offline',
          'connecting',
          'live',
        ]),
      ).toBe(1);

      closeChannelAndSettle(unsub);
      vi.useRealTimers();
    });

    it('does not bump while still offline', () => {
      const unsub = mountConsumer();
      deliverStatus('live');

      // FR-023 is about what happens *after* the channel is re-established.
      // Refetching mid-outage would just fail, repeatedly.
      expect(bumpsOver(['offline', 'connecting', 'offline'])).toBe(0);

      deliverStatus('connecting');
      closeChannelAndSettle(unsub);
      vi.useRealTimers();
    });

    it('bumps on recovery even if the channel never connected at all', () => {
      const unsub = mountConsumer();

      // The API was down when the page loaded, so the mount fetches failed and
      // the screens are showing errors rather than stale data. Reaching `live`
      // for the first time is still a recovery, and the refetch is what clears
      // them.
      expect(bumpsOver(['offline', 'connecting', 'live'])).toBe(1);

      closeChannelAndSettle(unsub);
      vi.useRealTimers();
    });

    it('does not bump on the reopen after a deliberate teardown', () => {
      const unsub = mountConsumer();
      deliverStatus('live');
      closeChannelAndSettle(unsub);

      // Navigating away long enough to close the channel, then back. The
      // teardown passes through `connecting`, which looks exactly like the
      // start of a gap — but whatever mounts next fetches on mount, so a bump
      // here is the duplicate fetch the flag exists to prevent.
      const unsubNext = mountConsumer();
      expect(bumpsOver(['live'])).toBe(0);

      closeChannelAndSettle(unsubNext);
      vi.useRealTimers();
    });

    it('reaches every consumer and moves none of them', () => {
      const unsub = mountConsumer();
      deliverStatus('live');
      deliverStatus('offline');
      deliverStatus('connecting');
      deliverStatus('live');

      const snap = getSnapshot();
      // Each of these is a gate some consumer would have dropped the bump on.
      // `analytics.updated` is skipped by the in-flight surface, the history
      // list and the weekly list; a non-null week exempts every other week;
      // and `own-workout` is the one origin permitted to move the dashboard.
      expect(snap.changeType).toBeNull();
      expect(snap.isoWeek).toBeNull();
      expect(snap.performedAt).toBeNull();
      expect(snap.origin).toBe('remote');
      expect(snap.settledStatus).toBeNull();

      closeChannelAndSettle(unsub);
      vi.useRealTimers();
    });

    it('does not claim a workout this tab logged', () => {
      const unsub = mountConsumer();
      publishWorkoutLogged('w-recon', '2026-09-14T00:00:00.000Z');
      deliverStatus('live');
      deliverStatus('offline');
      deliverStatus('connecting');
      deliverStatus('live');

      // The id stays pending, so the settle that eventually arrives is still
      // recognised as this tab's. A bump that consumed it would cost the one
      // navigation FR-018 permits.
      expect(getSnapshot().origin).toBe('remote');
      deliverRemote('2026-09-14T00:00:00.000Z', { workoutId: 'w-recon' });
      expect(getSnapshot().origin).toBe('own-workout');

      closeChannelAndSettle(unsub);
      vi.useRealTimers();
    });
  });

  it('can be read without opening the channel', () => {
    const startsBefore = captured.starts;

    const unsubStatus = subscribeToChannelStatus(() => {});
    expect(getChannelStatus()).toBe('connecting');

    // A status indicator renders on screens that display nothing the channel
    // could update. If subscribing opened a stream, those screens would each
    // hold a connection against the per-user cap (FR-028).
    expect(captured.starts).toBe(startsBefore);

    unsubStatus();
    vi.useRealTimers();
  });
});
