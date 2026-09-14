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

/** Delivers a notification through the captured handler. Content is irrelevant by design. */
function deliverRemote(): void {
  captured.handlers?.onNotification({
    type: 'workout.settled',
    event_id: 'evt-1',
    user_id: 'u1',
    occurred_at: '2026-09-14T00:00:00.000Z',
    workout_id: 'w1',
    status: 'parsed',
    performed_at: '2026-09-07T00:00:00.000Z',
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
      // The property holds because the notification carries no data: a repeat
      // costs a redundant refetch, never a wrong state. This test exists to
      // keep that true — a future change that starts putting payload in the
      // event would break convergence silently, and this is what would catch it.
      const before = getSnapshot();

      deliverRemote();
      const once = getSnapshot();

      deliverRemote();
      const twice = getSnapshot();

      expect(once.lastPerformedAt).toBe(before.lastPerformedAt);
      expect(twice.lastPerformedAt).toBe(once.lastPerformedAt);
    });

    it('reaches the same state whichever order two notifications arrive in', () => {
      deliverRemote();
      deliverRemote();
      const afterAB = getSnapshot().lastPerformedAt;

      deliverRemote();
      deliverRemote();
      const afterBA = getSnapshot().lastPerformedAt;

      expect(afterBA).toBe(afterAB);
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
    it('records the date only for a locally logged workout', () => {
      publishWorkoutLogged('2026-09-07T00:00:00.000Z');

      expect(getSnapshot().lastPerformedAt).toBe('2026-09-07T00:00:00.000Z');
    });

    it('leaves the date null for a change that came over the channel', () => {
      // The dashboard follows `lastPerformedAt` to switch week (FR-012). A
      // workout logged on another device must never pull this screen to its
      // week — FR-018 and US3 scenario 3 forbid exactly that.
      deliverRemote();

      expect(getSnapshot().lastPerformedAt).toBeNull();
    });

    it('leaves the date null after a deletion', () => {
      // Deleting must refresh the week on screen, never navigate away from it.
      publishWorkoutLogged('2026-09-07T00:00:00.000Z');
      publishWorkoutDeleted();

      expect(getSnapshot().lastPerformedAt).toBeNull();
    });

    it('lets a remote change clear a date a local one had just set', () => {
      // Documented, not endorsed. Today nothing publishes workout.created, so
      // this sequence does not occur in practice. Once T038 lands it will occur
      // on *every* local log: our own POST makes the server publish
      // workout.created, which returns over our own channel milliseconds later
      // and overwrites the date the form had just recorded.
      //
      // The dashboard's effect (features/dashboard/dashboard.tsx) reads both
      // fields from one snapshot: it would see the revision move but the date
      // gone, and skip the week switch FR-012 requires. T032 owns that rule and
      // has to reckon with this — either by keeping the local signal separate
      // from the shared counter, or by ignoring a remote notification about a
      // workout this session just created.
      publishWorkoutLogged('2026-09-07T00:00:00.000Z');
      expect(getSnapshot().lastPerformedAt).toBe('2026-09-07T00:00:00.000Z');

      deliverRemote();
      expect(getSnapshot().lastPerformedAt).toBeNull();
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
