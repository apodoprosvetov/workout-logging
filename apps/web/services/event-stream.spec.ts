import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiFetch } from './api-client';
import { applyJitter, backoffDelay, parseFrames, startEventStream } from './event-stream';

import type { ChannelStatus } from './event-stream';

// Only `apiFetch` is replaced — `ApiError` stays real, because the stream
// constructs one itself for a non-ok response and a stub would make that
// construction untested.
vi.mock('./api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api-client')>()),
  apiFetch: vi.fn(),
}));

// A stream arrives in arbitrary chunks, so every boundary case below is
// something a real socket will eventually do.

describe('parseFrames', () => {
  describe('framing', () => {
    it('parses a single complete frame', () => {
      const { frames, rest } = parseFrames('', 'event: workout.settled\ndata: {"id":1}\n\n');

      expect(frames).toEqual([{ event: 'workout.settled', data: '{"id":1}' }]);
      expect(rest).toBe('');
    });

    it('holds an incomplete frame in `rest` and emits nothing', () => {
      const { frames, rest } = parseFrames('', 'event: workout.settled\ndata: {"id":1}');

      expect(frames).toEqual([]);
      expect(rest).toBe('event: workout.settled\ndata: {"id":1}');
    });

    it('joins a frame split across two chunks', () => {
      // The reason this function takes a buffer at all. A socket splits wherever
      // it likes — mid-field, mid-JSON, between the two newlines.
      const first = parseFrames('', 'event: workout.settled\nda');
      expect(first.frames).toEqual([]);

      const second = parseFrames(first.rest, 'ta: {"id":1}\n\n');
      expect(second.frames).toEqual([{ event: 'workout.settled', data: '{"id":1}' }]);
      expect(second.rest).toBe('');
    });

    it('survives a split landing between the two terminating newlines', () => {
      const first = parseFrames('', 'event: a\ndata: 1\n');
      expect(first.frames).toEqual([]);

      const second = parseFrames(first.rest, '\n');
      expect(second.frames).toEqual([{ event: 'a', data: '1' }]);
    });

    it('emits several frames arriving in one chunk', () => {
      const { frames, rest } = parseFrames(
        '',
        'event: a\ndata: 1\n\nevent: b\ndata: 2\n\nevent: c\ndata: 3\n\n',
      );

      expect(frames).toEqual([
        { event: 'a', data: '1' },
        { event: 'b', data: '2' },
        { event: 'c', data: '3' },
      ]);
      expect(rest).toBe('');
    });

    it('emits the complete frames and keeps the trailing partial one', () => {
      const { frames, rest } = parseFrames('', 'event: a\ndata: 1\n\nevent: b\ndata: 2');

      expect(frames).toEqual([{ event: 'a', data: '1' }]);
      expect(rest).toBe('event: b\ndata: 2');
    });

    it('returns nothing for an empty chunk and preserves the buffer', () => {
      const { frames, rest } = parseFrames('event: a', '');

      expect(frames).toEqual([]);
      expect(rest).toBe('event: a');
    });
  });

  describe('the leading newline our own server sends', () => {
    it('does not invent a frame from the stream’s opening blank line', () => {
      // Verified against the real thing in the T003 spike: Nest's @Sse() opens
      // with a bare '\n' before the first frame. A naive split on '\n\n' turns
      // that into an empty leading segment, and an unguarded parser emits a
      // phantom frame with no event and no data.
      const { frames } = parseFrames('', '\nevent: workout.settled\nid: 1\ndata: {"a":1}\n\n');

      expect(frames).toEqual([{ event: 'workout.settled', data: '{"a":1}' }]);
    });

    it('parses a verbatim capture from the running API', () => {
      // Copied from an actual `curl -N` against GET /api/events, heartbeat and
      // all — the shape the client will really meet.
      const captured =
        '\nevent: workout.settled\nid: 1\ndata: {"type":"workout.settled","event_id":"e1"}\n\n' +
        'event: heartbeat\nid: 2\ndata: \n\n';

      const { frames, rest } = parseFrames('', captured);

      expect(frames).toEqual([
        { event: 'workout.settled', data: '{"type":"workout.settled","event_id":"e1"}' },
        { event: 'heartbeat', data: '' },
      ]);
      expect(rest).toBe('');
    });
  });

  describe('fields', () => {
    it('ignores `id:`, which this design does not honour', () => {
      // contracts/api.md: Last-Event-ID resumption is not offered — a client
      // that missed messages refetches instead of replaying. Nest assigns ids
      // anyway, so the parser has to tolerate them.
      const { frames } = parseFrames('', 'event: a\nid: 42\ndata: 1\n\n');

      expect(frames).toEqual([{ event: 'a', data: '1' }]);
    });

    it('strips exactly one optional space after the colon', () => {
      const { frames } = parseFrames('', 'event:a\ndata:  two-spaces\n\n');

      // One space is separator, any further space is part of the value.
      expect(frames).toEqual([{ event: 'a', data: ' two-spaces' }]);
    });

    it('joins multiple data lines with newlines', () => {
      const { frames } = parseFrames('', 'event: a\ndata: line one\ndata: line two\n\n');

      expect(frames).toEqual([{ event: 'a', data: 'line one\nline two' }]);
    });

    it('keeps an empty first data line when more follow', () => {
      // Regression: an implementation that appends only when the accumulator is
      // truthy loses this, because '' is falsy — the second line replaces the
      // first instead of joining it. The suite missed it at first because every
      // other multi-line case starts with a non-empty line.
      const { frames } = parseFrames('', 'event: a\ndata: \ndata: second\n\n');

      expect(frames).toEqual([{ event: 'a', data: '\nsecond' }]);
    });

    it('keeps both lines when every data line is empty', () => {
      const { frames } = parseFrames('', 'event: a\ndata: \ndata: \n\n');

      expect(frames).toEqual([{ event: 'a', data: '\n' }]);
    });

    it('defaults the event name to `message` when the field is absent', () => {
      const { frames } = parseFrames('', 'data: bare\n\n');

      expect(frames).toEqual([{ event: 'message', data: 'bare' }]);
    });

    it('keeps a frame whose data is empty', () => {
      // The heartbeat's shape. Dropping "empty" frames would make the channel
      // look silent, and liveness detection (FR-025) is built on seeing these.
      const { frames } = parseFrames('', 'event: heartbeat\ndata: \n\n');

      expect(frames).toEqual([{ event: 'heartbeat', data: '' }]);
    });
  });

  describe('comments and junk', () => {
    it('ignores a comment line', () => {
      const { frames } = parseFrames('', ': keep-alive\n\nevent: a\ndata: 1\n\n');

      expect(frames).toEqual([{ event: 'a', data: '1' }]);
    });

    it('ignores a comment sitting inside an otherwise good frame', () => {
      const { frames } = parseFrames('', 'event: a\n: a note\ndata: 1\n\n');

      expect(frames).toEqual([{ event: 'a', data: '1' }]);
    });

    it('does not mistake data that merely starts with a colon for a comment', () => {
      // Only the line's first character decides. Detecting comments by "has a
      // colon" — or by testing the value rather than the line — would silently
      // swallow this frame.
      const { frames } = parseFrames('', 'event: a\ndata: :x\n\n');

      expect(frames).toEqual([{ event: 'a', data: ':x' }]);
    });

    it('drops an unrecognised field without discarding the frame', () => {
      const { frames } = parseFrames('', 'event: a\nretry: 5000\nweird: x\ndata: 1\n\n');

      expect(frames).toEqual([{ event: 'a', data: '1' }]);
    });

    it('drops a frame carrying no data at all', () => {
      // Nothing to act on, and emitting it would force every caller to guard.
      const { frames, rest } = parseFrames('', 'id: 7\n\nevent: a\ndata: 1\n\n');

      expect(frames).toEqual([{ event: 'a', data: '1' }]);
      expect(rest).toBe('');
    });
  });

  describe('purity', () => {
    it('does not carry state between calls', () => {
      // The whole point of threading `rest` through the signature: two
      // independent streams can share the function with no interference.
      const a = parseFrames('', 'event: a\ndata: 1\n\n');
      const b = parseFrames('', 'event: b\ndata: 2\n\n');

      expect(a.frames).toEqual([{ event: 'a', data: '1' }]);
      expect(b.frames).toEqual([{ event: 'b', data: '2' }]);
    });
  });
});

// Written against the contract rather than the implementation — the exact base
// and ceiling are a judgement call, so most of these assert properties that
// hold whatever numbers were picked, and derive the ceiling from the function
// itself. The two that *are* strict come from the spec, not from taste.
describe('backoffDelay', () => {
  // Any attempt far past the growth curve must already be at the ceiling.
  const ceiling = backoffDelay(1000);

  it('reconnects immediately on the first attempt', () => {
    // The commonest reconnect is not a failure but the 15-minute token
    // expiring, and charging it a delay costs every user a gap every 15 min.
    expect(backoffDelay(0)).toBe(0);
  });

  it('is deterministic — the same attempt always gives the same delay', () => {
    // Jitter is T042's job, applied on top. Putting Math.random() in here would
    // make the function impure and force this suite to stub a generator.
    expect(backoffDelay(3)).toBe(backoffDelay(3));
    expect(backoffDelay(7)).toBe(backoffDelay(7));
  });

  it('never goes backwards as attempts increase', () => {
    const delays = Array.from({ length: 25 }, (_, attempt) => backoffDelay(attempt));

    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    }
  });

  it('actually grows before it flattens', () => {
    // Guards against a "backoff" that is really a constant delay — which would
    // satisfy monotonicity above while doing nothing for FR-022's "back off
    // rather than retry in a tight loop".
    expect(backoffDelay(2)).toBeGreaterThan(backoffDelay(1));
    expect(backoffDelay(3)).toBeGreaterThan(backoffDelay(2));
  });

  it('reaches a ceiling and stays there', () => {
    expect(backoffDelay(100)).toBe(ceiling);
    expect(backoffDelay(1000)).toBe(ceiling);
    expect(backoffDelay(Number.MAX_SAFE_INTEGER)).toBe(ceiling);
  });

  it('keeps the ceiling inside SC-007’s recovery budget', () => {
    // SC-007 gives 10s from connectivity returning. At the ceiling the client
    // waits that delay *after* the network is back, so it alone can blow it.
    expect(ceiling).toBeLessThan(10_000);
    expect(ceiling).toBeGreaterThan(0);
  });

  it('never returns Infinity, NaN or a negative delay', () => {
    // 2 ** 1000 is Infinity; a ceiling applied with Math.min absorbs that, but
    // only if the order of operations is what the author thought it was.
    for (const attempt of [0, 1, 5, 50, 500, 5000, Number.MAX_SAFE_INTEGER]) {
      const delay = backoffDelay(attempt);
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
  });

  it('survives nonsense input without returning nonsense', () => {
    // Not a promise about *what* these produce — only that a caller mistake
    // cannot turn into an unbounded or negative setTimeout.
    for (const attempt of [-1, -100, 1.5]) {
      const delay = backoffDelay(attempt);
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(ceiling);
    }
  });
});

// Written against the contract rather than the implementation — the exact base
// and ceiling are a judgement call, so most of these assert properties that
// hold whatever numbers were picked.
describe('applyJitter', () => {
  const draws = (r: number) => () => r;

  it('leaves an immediate reconnect immediate', () => {
    // backoffDelay(0) is 0 on purpose — the routine token-expiry reopen. Jitter
    // must not smear a delay back onto it, so this holds for every draw.
    for (const r of [0, 0.5, 1]) {
      expect(applyJitter(0, draws(r))).toBe(0);
    }
  });

  it('never returns more than the delay it was given', () => {
    // The ceiling is load-bearing for SC-007: a jittered delay that could
    // exceed it would put the worst case outside the 10s recovery budget the
    // unjittered curve was chosen to fit inside.
    for (const delay of [250, 1000, 5000]) {
      expect(applyJitter(delay, draws(1))).toBeLessThanOrEqual(delay);
    }
  });

  it('never drops below half the delay', () => {
    // This is the half that FR-022 needs. "Full jitter" (random() * delay) has
    // no floor, so a client at the 5s ceiling can still draw single-digit
    // milliseconds and retry a dead server in what is effectively a tight loop.
    for (const delay of [250, 1000, 5000]) {
      expect(applyJitter(delay, draws(0))).toBe(delay / 2);
    }
  });

  it('actually spreads clients out across the range', () => {
    // Guards against a "jitter" that returns a constant — which would satisfy
    // both bounds above while leaving a restarted replica's clients returning
    // in step, the one thing this function exists to prevent.
    const spread = new Set([0, 0.25, 0.5, 0.75, 1].map((r) => applyJitter(5000, draws(r))));

    expect(spread.size).toBe(5);
  });

  it('is monotonic in the draw', () => {
    expect(applyJitter(5000, draws(0.25))).toBeLessThan(applyJitter(5000, draws(0.75)));
  });

  it('survives a generator that returns nonsense', () => {
    // Not a promise about *what* these produce — only that a broken or
    // out-of-range generator cannot turn into a negative or unbounded timer.
    for (const r of [NaN, -1, 2, Infinity]) {
      const delay = applyJitter(4000, draws(r));
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThanOrEqual(4000);
    }
  });

  it('survives nonsense input without returning nonsense', () => {
    for (const delay of [-1, NaN, Number.NEGATIVE_INFINITY]) {
      expect(applyJitter(delay, draws(0.5))).toBe(0);
    }
  });

  it('defaults to Math.random, so no caller has to supply one', () => {
    const delay = applyJitter(5000);

    expect(delay).toBeGreaterThanOrEqual(2500);
    expect(delay).toBeLessThanOrEqual(5000);
  });
});

// Behavioural, not unit: what these assert is the *shape of the retry traffic*
// a permanently broken backend sees, which is the only level at which "backs
// off rather than retries in a tight loop" and "gives up, but recoverably"
// mean anything. Time is faked, so a thirty-minute outage costs milliseconds.
describe('startEventStream reconnection', () => {
  const fetchMock = vi.mocked(apiFetch);
  const GIVE_UP_AFTER_MS = 30 * 60_000;

  /** Mutable `visibilityState`; `window` only ever needs to dispatch `online`. */
  let fakeDocument: EventTarget & { visibilityState: 'visible' | 'hidden' };
  let fakeWindow: EventTarget;
  /** Spied so a test can assert on *un*registration, which dispatching cannot show. */
  let windowRemove: ReturnType<typeof vi.spyOn>;
  let documentRemove: ReturnType<typeof vi.spyOn>;

  /** When each connection attempt was made, on the fake clock. */
  let attemptedAt: number[];

  function startFailingStream(onStatus?: (status: ChannelStatus) => void): () => void {
    return startEventStream({ onNotification: () => {}, onStatus });
  }

  /** `onStatus` spy plus the stream it is wired to, for the give-up assertions. */
  function startWatchedStream(): { stop: () => void; statuses: ChannelStatus[] } {
    const statuses: ChannelStatus[] = [];
    const stop = startFailingStream((status) => statuses.push(status));
    return { stop, statuses };
  }

  /** Gaps between consecutive attempts — gap[i] is the delay before attempt i+1. */
  function gaps(): number[] {
    return attemptedAt.slice(1).map((at, i) => at - attemptedAt[i]);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    attemptedAt = [];
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => {
      attemptedAt.push(Date.now());
      return Promise.reject(new Error('backend unreachable'));
    });

    // Every failed attempt logs; without this the suite prints hundreds of
    // lines of expected noise and buries a genuine warning.
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    fakeWindow = new EventTarget();
    fakeDocument = Object.assign(new EventTarget(), {
      visibilityState: 'visible' as 'visible' | 'hidden',
    });
    windowRemove = vi.spyOn(fakeWindow, 'removeEventListener');
    documentRemove = vi.spyOn(fakeDocument, 'removeEventListener');
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('document', fakeDocument);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens the first connection without waiting', async () => {
    const stop = startFailingStream();
    await vi.advanceTimersByTimeAsync(0);
    stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/events', expect.anything());
  });

  it('keeps every retry inside the jittered band for its attempt', async () => {
    const stop = startFailingStream();
    await vi.advanceTimersByTimeAsync(60_000);
    stop();

    gaps().forEach((gap, i) => {
      const unjittered = backoffDelay(i + 1);
      expect(gap).toBeGreaterThanOrEqual(Math.floor(unjittered / 2));
      expect(gap).toBeLessThanOrEqual(unjittered);
    });
  });

  it('does not return in step — the delays vary', async () => {
    const stop = startFailingStream();
    await vi.advanceTimersByTimeAsync(120_000);
    stop();

    // Sampled from the flat part of the curve, where an unjittered client would
    // produce one value repeated: every difference here is jitter, not growth.
    const atCeiling = gaps().slice(8);

    expect(atCeiling.length).toBeGreaterThan(5);
    expect(new Set(atCeiling).size).toBeGreaterThan(1);
  });

  it('stays at the ceiling instead of cycling back to zero', async () => {
    // Regression: the healthy window used to include the backoff sleep, so at
    // the ceiling the sleep alone scored every failing cycle as healthy and the
    // delays sawtoothed back to zero forever.
    //
    // Pinned to draw 1 because jitter *hides* it — a 3.4s draw never reaches the
    // 5s threshold, so real randomness would catch this a few times in a hundred.
    vi.spyOn(Math, 'random').mockReturnValue(1);

    const stop = startFailingStream();
    await vi.advanceTimersByTimeAsync(120_000);
    stop();

    const atCeiling = gaps().slice(8);

    expect(atCeiling.length).toBeGreaterThan(5);
    for (const gap of atCeiling) {
      expect(gap).toBe(5000);
    }
  });

  it('is still retrying well past the five minutes SC-007 allows for', async () => {
    const { stop } = startWatchedStream();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const beforeGiveUpWindow = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    stop();

    // SC-007 promises recovery after an interruption of up to five minutes, so
    // abandoning the channel anywhere near that mark would break it outright.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(beforeGiveUpWindow);
  });

  it('gives up, and then stops generating traffic', async () => {
    const { stop, statuses } = startWatchedStream();

    await vi.advanceTimersByTimeAsync(GIVE_UP_AFTER_MS + 60_000);
    const afterGivingUp = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    stop();

    expect(statuses.at(-1)).toBe('offline');
    // The point of giving up: ten further minutes cost nothing at all.
    expect(fetchMock.mock.calls.length).toBe(afterGivingUp);
  });

  it('reports connecting first, then offline once an attempt has failed', async () => {
    const { stop, statuses } = startWatchedStream();

    // Synchronously, before any timer has run: nothing has failed yet, so
    // claiming `offline` on a fresh page load would flash a "not receiving
    // updates" surface at every user on every visit.
    expect(statuses).toEqual(['connecting']);

    await vi.advanceTimersByTimeAsync(60_000);
    stop();

    // …but once a connection has actually failed, `connecting` would be the
    // stale-as-live claim FR-025 forbids, for however long the outage runs.
    expect(statuses).toEqual(['connecting', 'offline']);
  });

  it('never throws out of the stream, however long it fails', async () => {
    // FR-026: losing the channel is an enhancement lost, not a failure state.
    // A rejection escaping `run()` would surface as an unhandled rejection in
    // the app that mounted the store.
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    const stop = startFailingStream();
    await vi.advanceTimersByTimeAsync(GIVE_UP_AFTER_MS + 60_000);
    stop();
    await vi.advanceTimersByTimeAsync(0);
    process.off('unhandledRejection', unhandled);

    expect(unhandled).not.toHaveBeenCalled();
  });

  describe('after giving up', () => {
    /** Runs a stream to exhaustion and returns it still stopped-but-alive. */
    async function givenGivenUp(): Promise<{ stop: () => void; attemptsSoFar: number }> {
      const stop = startFailingStream();
      await vi.advanceTimersByTimeAsync(GIVE_UP_AFTER_MS + 60_000);
      return { stop, attemptsSoFar: fetchMock.mock.calls.length };
    }

    it('resumes immediately when the network comes back', async () => {
      const { stop, attemptsSoFar } = await givenGivenUp();

      fakeWindow.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(0);
      stop();

      // Attempt 0, not the ceiling it had earned: `online` is evidence the
      // world changed, so nothing is gained by making the user wait it out.
      expect(fetchMock.mock.calls.length).toBe(attemptsSoFar + 1);
    });

    it('resumes when a backgrounded tab is looked at again', async () => {
      // The case that would otherwise strand a user: a laptop closed overnight,
      // where the network was never broken because there was no network.
      const { stop, attemptsSoFar } = await givenGivenUp();

      fakeDocument.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      stop();

      expect(fetchMock.mock.calls.length).toBe(attemptsSoFar + 1);
    });

    it('ignores a tab going hidden', async () => {
      const { stop, attemptsSoFar } = await givenGivenUp();

      fakeDocument.visibilityState = 'hidden';
      fakeDocument.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(1000);
      stop();

      expect(fetchMock.mock.calls.length).toBe(attemptsSoFar);
    });

    it('resumes only once when both signals arrive together', async () => {
      // Waking a laptop fires `online` and `visibilitychange` within a frame of
      // each other, and two live loops would double every subsequent retry —
      // so `resume` has to be idempotent, not merely correct once.
      const { stop, attemptsSoFar } = await givenGivenUp();

      fakeWindow.dispatchEvent(new Event('online'));
      fakeDocument.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      stop();

      expect(fetchMock.mock.calls.length).toBe(attemptsSoFar + 1);
    });

    it('gives up again if the resumed stream fails just as long', async () => {
      const { stop, statuses } = startWatchedStream();
      await vi.advanceTimersByTimeAsync(GIVE_UP_AFTER_MS + 60_000);
      const attemptsBeforeResume = fetchMock.mock.calls.length;

      fakeWindow.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(GIVE_UP_AFTER_MS + 60_000);
      const attemptsAfterSecondGiveUp = fetchMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      stop();

      // The give-up budget is a fresh half hour, not a lifetime total — a
      // one-shot bound would leave a resumed stream retrying forever, and a
      // never-reset `failingSince` would abandon it after a single attempt.
      expect(fetchMock.mock.calls.length - attemptsBeforeResume).toBeGreaterThan(100);
      expect(fetchMock.mock.calls.length).toBe(attemptsAfterSecondGiveUp);
      expect(statuses.at(-1)).toBe('offline');
    });

    it('lets go of the window and document once stopped', async () => {
      // Behaviourally invisible (`resume` checks `stopped` anyway), so nothing
      // else here can see it. The cost is a leak: the listeners close over the
      // stream, and a channel torn down per navigation would pin them all.
      const { stop } = await givenGivenUp();

      stop();

      expect(windowRemove).toHaveBeenCalledWith('online', expect.any(Function));
      expect(documentRemove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    });

    it('stays stopped once the caller stops it', async () => {
      const { stop, attemptsSoFar } = await givenGivenUp();
      stop();

      fakeWindow.dispatchEvent(new Event('online'));
      fakeDocument.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(60_000);

      // A store that tore the channel down on unmount must not find it
      // resurrected by a network event minutes later.
      expect(fetchMock.mock.calls.length).toBe(attemptsSoFar);
    });
  });
});

// A real `ReadableStream`, not a rejecting stub: the cases that matter — an
// open silent socket, one cut by an intermediary — are indistinguishable from
// a healthy connection at every level above the bytes.
describe('startEventStream liveness', () => {
  const fetchMock = vi.mocked(apiFetch);
  const HEARTBEAT_INTERVAL_MS = 15_000;
  const QUIET_TIMEOUT_MS = 2 * HEARTBEAT_INTERVAL_MS;

  const HEARTBEAT = 'event: heartbeat\ndata: \n\n';
  const NOTIFICATION =
    'event: workout.created\n' +
    'data: {"type":"workout.created","event_id":"e1","user_id":"u1",' +
    '"workout_id":"w1","performed_at":"2026-09-07T00:00:00.000Z",' +
    '"occurred_at":"2026-09-07T00:00:00.000Z"}\n\n';

  interface Served {
    send: (text: string) => void;
    close: () => void;
  }

  let served: Served[];
  let statuses: ChannelStatus[];
  let notifications: unknown[];

  /** The connection the stream is currently reading. */
  function current(): Served {
    return served[served.length - 1];
  }

  /** Let enqueued bytes reach the reader without moving the clock. */
  async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }

  /** Advance to just past the point where a silent connection is given up on. */
  async function goQuiet(): Promise<void> {
    await vi.advanceTimersByTimeAsync(QUIET_TIMEOUT_MS + 1);
  }

  function start(): () => void {
    return startEventStream({
      onNotification: (n) => notifications.push(n),
      onStatus: (s) => statuses.push(s),
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    served = [];
    statuses = [];
    notifications = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal(
      'document',
      Object.assign(new EventTarget(), { visibilityState: 'visible' as const }),
    );

    fetchMock.mockReset();
    fetchMock.mockImplementation((_path, init) => {
      const encoder = new TextEncoder();
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let open = true;
      const body = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
        },
      });

      // A real fetch errors the body when its signal aborts. Without this the
      // watchdog would abort a connection and then wait forever on a reader
      // that is still perfectly happy — the suite would hang rather than fail,
      // which is the worst way for a test to be wrong.
      init?.signal?.addEventListener('abort', () => {
        if (!open) return;
        open = false;
        controller.error(new DOMException('aborted', 'AbortError'));
      });

      served.push({
        send: (text) => open && controller.enqueue(encoder.encode(text)),
        close: () => {
          if (!open) return;
          open = false;
          controller.close();
        },
      });

      return Promise.resolve({ ok: true, status: 200, body } as Response);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not call itself live just because a socket opened', async () => {
    const stop = start();
    await settle();

    // research #9: an intermediary can cut a stream and leave a socket that
    // looks open and never delivers again. Trusting the socket is exactly how
    // a screen ends up presenting stale data as live (FR-025).
    expect(statuses).toEqual(['connecting']);

    stop();
  });

  it('does not count the blank line our server opens with as a heartbeat', async () => {
    // Nest writes a leading newline before it has anything to say. It is real
    // traffic — it proves a socket — but it is not the evidence `live` claims.
    const stop = start();
    await settle();
    current().send('\n');
    await settle();

    expect(statuses).toEqual(['connecting']);

    stop();
  });

  it('goes live when the first heartbeat arrives', async () => {
    const stop = start();
    await settle();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    current().send(HEARTBEAT);
    await settle();

    expect(statuses).toEqual(['connecting', 'live']);

    stop();
  });

  it('stays live, and says so once, while heartbeats keep arriving', async () => {
    const stop = start();
    await settle();

    for (let beat = 0; beat < 10; beat++) {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
      current().send(HEARTBEAT);
      await settle();
    }

    // Two and a half minutes on one connection: the watchdog must be reset by
    // each beat, not merely started once. And `onStatus` is deduplicated, so a
    // consumer can render it without guarding against a beat-rate re-render.
    expect(statuses).toEqual(['connecting', 'live']);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    stop();
  });

  it('tolerates a single late beat', async () => {
    const stop = start();
    await settle();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    current().send(HEARTBEAT);
    await settle();

    // One beat missed entirely and the next arriving a second before the
    // deadline. Two intervals exists to absorb exactly this; one interval
    // would tear down a working channel over a late packet.
    await vi.advanceTimersByTimeAsync(QUIET_TIMEOUT_MS - 1000);
    current().send(HEARTBEAT);
    await settle();

    expect(statuses).toEqual(['connecting', 'live']);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    stop();
  });

  it('counts a notification as traffic too', async () => {
    const stop = start();
    await settle();

    // A busy channel may deliver notifications and no idle heartbeat at all.
    // Liveness is about traffic, not about one frame type.
    for (let sent = 0; sent < 4; sent++) {
      await vi.advanceTimersByTimeAsync(QUIET_TIMEOUT_MS - 1000);
      current().send(NOTIFICATION);
      await settle();
    }

    expect(statuses).toEqual(['connecting', 'live']);
    expect(notifications).toHaveLength(4);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    stop();
  });

  it('drops a socket that goes quiet, and reconnects', async () => {
    const stop = start();
    await settle();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    current().send(HEARTBEAT);
    await settle();
    expect(statuses).toEqual(['connecting', 'live']);

    // Nothing closes, nothing errors — the connection simply stops delivering.
    // This is the failure SC-008 is about: a screen idle for half an hour must
    // still get the next change, and a zombie socket silently guarantees it
    // never will.
    await goQuiet();

    expect(statuses).toEqual(['connecting', 'live', 'offline', 'connecting']);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    stop();
  });

  it('drops a socket that never says anything at all', async () => {
    // No heartbeat ever, not even the opening newline: the clock has to start
    // at the response rather than at the first chunk, or this hangs forever.
    const stop = start();
    await settle();
    await goQuiet();

    expect(statuses).toEqual(['connecting', 'offline', 'connecting']);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    stop();
  });

  it('comes back to live on the connection the watchdog opened', async () => {
    const stop = start();
    await settle();
    await goQuiet();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    current().send(HEARTBEAT);
    await settle();

    // The watchdog aborts a connection, which reaches `run` as an AbortError —
    // the same error the caller's own stop produces. Keying the loop's exit on
    // the error rather than on `stopped` would end the stream here, silently
    // and permanently, the first time a channel went quiet.
    expect(statuses).toEqual(['connecting', 'offline', 'connecting', 'live']);
    expect(notifications).toHaveLength(0);

    stop();
  });

  it('reconnects immediately after a long healthy connection goes quiet', async () => {
    const stop = start();
    await settle();
    for (let beat = 0; beat < 4; beat++) {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
      current().send(HEARTBEAT);
      await settle();
    }
    const droppedAt = Date.now() + QUIET_TIMEOUT_MS;

    await goQuiet();

    // A connection that worked for a minute earned a reset of the backoff, so
    // the replacement opens at once rather than paying a penalty the outage
    // never incurred.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Date.now() - droppedAt).toBeLessThan(100);

    stop();
  });

  it('stops watching once the caller stops it', async () => {
    const stop = start();
    await settle();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    current().send(HEARTBEAT);
    await settle();

    stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    // A live connection torn down by the caller must not leave a watchdog
    // behind that fires minutes later and opens a connection nobody wants.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(['connecting', 'live']);
  });

  it('treats a server closing the stream as a reconnect, not a quiet socket', async () => {
    const stop = start();
    await settle();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    current().send(HEARTBEAT);
    await settle();

    // The routine case: the access token expired and the server closed. It is
    // a clean close, so nothing should report `offline` on the way through.
    current().close();
    await settle();

    expect(statuses).toEqual(['connecting', 'live', 'connecting']);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    stop();
  });
});
