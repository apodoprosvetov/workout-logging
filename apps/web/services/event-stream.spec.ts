import { describe, expect, it } from 'vitest';

import { backoffDelay, parseFrames } from './event-stream';

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
