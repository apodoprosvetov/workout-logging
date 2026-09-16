import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiFetch } from './api-client';
import { applyJitter, backoffDelay, parseFrames, startEventStream } from './event-stream';

// Only `apiFetch` is replaced — `ApiError` stays real, because the stream
// constructs one itself for a non-ok response and a stub would make that
// construction untested.
vi.mock('./api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api-client')>()),
  apiFetch: vi.fn(),
}));

// The parser is the one piece of this feature that is pure input/output, and
// also the easiest to get subtly wrong: a stream arrives in arbitrary chunks,
// so every boundary case below is something a real socket will eventually do.
//
// Written before the implementation (T016 ahead of T015) so the interface is
// decided by what callers need rather than by what the first draft happened to
// return.

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
    // The most common reconnect here is not a failure: the access token lives
    // 15 minutes, the server closes the stream, the client opens a new one.
    // Charging a delay for that would cost every user a gap every 15 minutes
    // for no reason. Growth belongs to *repeated* failures, which is why the
    // caller must reset the counter after a successful connection.
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
    // SC-007: after an interruption of up to 5 minutes, the screen must show
    // current data within 10 seconds of connectivity returning. After five
    // minutes of failures the client is at the ceiling, so the worst case is
    // waiting a full ceiling *after* the network is already back — the delay
    // alone can blow the budget. Room is left for the request itself.
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

  function startFailingStream(onGiveUp?: () => void): () => void {
    return startEventStream({ onNotification: () => {}, onGiveUp });
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
    // Regression: the healthy-connection window used to open *before* the
    // backoff sleep, so the sleep counted toward the connection's own lifetime.
    // Once the delay reached the 5s ceiling it satisfied MIN_HEALTHY_CONNECTION_MS
    // on its own, every failing cycle scored as healthy, and the delays
    // sawtoothed 0→250→…→5000→0 forever against a backend that was never once
    // reachable — with `failingSince` cleared each lap, so the give-up below
    // could never be reached either.
    //
    // Pinned to the top of the jitter band deliberately. Jitter *hides* this
    // bug: a 3.4s draw does not reach the 5s threshold, so the reset fires only
    // on a near-maximum draw and a test on real randomness would catch it a few
    // times in a hundred. At draw 1 the delay is exactly the ceiling, which is
    // the boundary the comparison gets wrong, and the sawtooth is certain.
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
    const onGiveUp = vi.fn();
    const stop = startFailingStream(onGiveUp);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const beforeGiveUpWindow = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    stop();

    // SC-007 promises recovery after an interruption of up to five minutes, so
    // abandoning the channel anywhere near that mark would break it outright.
    expect(onGiveUp).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(beforeGiveUpWindow);
  });

  it('gives up once, and then stops generating traffic', async () => {
    const onGiveUp = vi.fn();
    const stop = startFailingStream(onGiveUp);

    await vi.advanceTimersByTimeAsync(GIVE_UP_AFTER_MS + 60_000);
    const afterGivingUp = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    stop();

    expect(onGiveUp).toHaveBeenCalledTimes(1);
    // The point of giving up: ten further minutes cost nothing at all.
    expect(fetchMock.mock.calls.length).toBe(afterGivingUp);
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
      const onGiveUp = vi.fn();
      const stop = startFailingStream(onGiveUp);
      await vi.advanceTimersByTimeAsync(GIVE_UP_AFTER_MS + 60_000);
      expect(onGiveUp).toHaveBeenCalledTimes(1);

      fakeWindow.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(GIVE_UP_AFTER_MS + 60_000);
      stop();

      // The give-up budget is a fresh half hour, not a lifetime total — a
      // one-shot bound would leave a resumed stream retrying forever.
      expect(onGiveUp).toHaveBeenCalledTimes(2);
    });

    it('lets go of the window and document once stopped', async () => {
      // Behaviourally invisible — `resume` checks `stopped` and would decline
      // anyway — so nothing else in this suite can see it. What it costs is a
      // leak: the listeners close over the whole stream, and a store that
      // opened and tore down a channel per navigation would pin every one of
      // them to the page for as long as the tab lives.
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
