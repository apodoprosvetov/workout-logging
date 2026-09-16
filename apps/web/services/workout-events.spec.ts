import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const { getSnapshot, publishWorkoutDeleted, publishWorkoutLogged, subscribe } =
  await import('./workout-events');

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
function deliverRemote(performedAt = '2026-09-14T00:00:00.000Z'): void {
  captured.handlers?.onNotification({
    type: 'workout.settled',
    event_id: 'evt-1',
    user_id: 'u1',
    occurred_at: '2026-09-14T00:00:00.000Z',
    workout_id: 'w1',
    status: 'parsed',
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
      publishWorkoutLogged('2026-09-07T00:00:00.000Z');
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
      publishWorkoutLogged('2026-09-07T00:00:00.000Z');

      const s = getSnapshot();
      expect(s.origin).toBe('local');
      expect(s.performedAt).toBe('2026-09-07T00:00:00.000Z');
      // A local change is not a notification and has no type to report.
      expect(s.changeType).toBeNull();
    });

    it('marks a change from the channel remote, and carries its date', () => {
      // The date is kept rather than blanked (T032). A week-scoped list cannot
      // honour FR-019 without it — it has to know which week moved. What stops
      // the dashboard from *navigating* on this is `origin`, not a missing date.
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
      publishWorkoutLogged('2026-09-07T00:00:00.000Z');
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
      publishWorkoutLogged('2026-09-16T00:00:00.000Z');

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
      // saw the revision move with the date gone and skipped the week switch
      // FR-012 requires.
      //
      // Nothing is blanked now. The echo overwrites the snapshot, but it is
      // marked `remote`, and the dashboard's effect returns on that before it
      // ever looks at the date. The local switch already happened at its own
      // revision; the echo is a refresh, not a second navigation.
      publishWorkoutLogged('2026-09-07T00:00:00.000Z');
      expect(getSnapshot().origin).toBe('local');
      expect(getSnapshot().performedAt).toBe('2026-09-07T00:00:00.000Z');

      deliverRemote('2026-09-07T00:00:00.000Z');

      const echoed = getSnapshot();
      expect(echoed.origin).toBe('remote');
      // The date survives rather than being destroyed — but origin is what any
      // consumer deciding to navigate must read, and it now says "not you".
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
});
