import { ApiError, apiFetch } from './api-client';

import type { ChangeNotification, NotificationType } from '@workout-logging/shared';

// Mirrors the NotificationType union in @workout-logging/shared. Duplicated as
// literals rather than imported as values: this is a type-only dependency, so
// there is nothing to import at runtime — the guard below needs the values.
const NOTIFICATION_TYPES: ReadonlySet<NotificationType> = new Set([
  'workout.settled',
  'workout.created',
  'workout.deleted',
  'analytics.updated',
]);

/** Runtime guard for `NotificationType` — the type itself vanishes at runtime. */
function isNotificationType(event: string): event is NotificationType {
  return NOTIFICATION_TYPES.has(event as NotificationType);
}
/**
 * One SSE frame, still as text.
 *
 * Deliberately *not* a ChangeNotification: this layer knows nothing about what
 * the payload means, only how the stream is framed. Two reasons it stops here —
 * a heartbeat (`event: heartbeat` with empty data) is a frame but not a
 * notification, and turning `data` into an object means `JSON.parse`, which
 * throws. A pure function has no good answer to a throw; the reader (T018) does,
 * because it can log and drop one bad message without losing the stream.
 */
export interface SseFrame {
  /** The `event:` field, or `'message'` — the SSE default when it is absent. */
  event: string;
  /** Every `data:` line joined with newlines; `''` when the frame carried none. */
  data: string;
}

const DEFAULT_EVENT_NAME = 'message';

const BASE_DELAY: number = 250; // mc
const MAX_DELAY: number = 5000; // mc
const MULTIPLIER: number = 2; // Exponential multiplier

/**
 * Split an SSE byte stream into complete frames.
 *
 * Pure, with the carry-over made explicit: `rest` is whatever did not yet end in
 * a blank line, and the caller feeds it back as `buffer` with the next chunk.
 * Streaming is inherently stateful, and threading the state through the
 * signature is what keeps this testable with no setup and no instance.
 *
 * **LF only — CRLF is deliberately unsupported.** The SSE spec allows `\r\n`,
 * but our one producer is Nest's `@Sse()`, whose raw output was checked byte by
 * byte in the T003 spike and uses `\n`. Nothing between here and there rewrites
 * line endings. Worth knowing how it would fail if that ever changed: the frame
 * boundary is matched as `\n\n`, so `\r\n\r\n` matches nothing at all and the
 * whole stream silently accumulates in `rest` — not a stray `\r` in a value,
 * but total silence.
 */
export function parseFrames(buffer: string, chunk: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];

  let workingBuffer = buffer + chunk;
  let boundaryIdx = workingBuffer.indexOf('\n\n');

  while (boundaryIdx !== -1) {
    const frameText = workingBuffer.slice(0, boundaryIdx);
    workingBuffer = workingBuffer.slice(boundaryIdx + 2);

    const lines = frameText.split('\n');
    const frame: Partial<SseFrame> = {};
    let hasData = false;

    for (const line of lines) {
      // A line *beginning* with a colon is an SSE comment — the keep-alive form
      // servers use to hold an idle connection open. Skipped explicitly rather
      // than left to fall through the switch below: it would land there with an
      // empty field name and match no case, which gets the right answer for the
      // wrong reason and reads like an oversight.
      //
      // `startsWith`, not "contains a colon": data may legitimately begin with
      // one (`data: :x` carries the value `:x`), and only the line's first
      // character makes it a comment.
      if (!line.trim() || line.startsWith(':')) {
        continue;
      }

      const colonIdx = line.indexOf(':');
      let field = line;
      let value = '';

      if (colonIdx !== -1) {
        field = line.slice(0, colonIdx).trim();
        value = line.slice(colonIdx + 1);
        if (value.startsWith(' ')) {
          value = value.slice(1);
        }
      }

      switch (field) {
        case 'event':
          frame.event = value;
          break;
        case 'data':
          frame.data = frame.data === undefined ? value : `${frame.data}\n${value}`;
          hasData = true;
          break;
      }
    }

    if (hasData) {
      if (!frame.event) {
        frame.event = DEFAULT_EVENT_NAME;
      }
      frames.push(frame as SseFrame);
    }

    boundaryIdx = workingBuffer.indexOf('\n\n');
  }

  return {
    frames,
    rest: workingBuffer,
  };
}

export function backoffDelay(attempt: number) {
  // guard for negatives
  const currentAttempt = Math.max(0, attempt);

  if (currentAttempt === 0) {
    return 0;
  }

  const calculatedDelay = BASE_DELAY * Math.pow(MULTIPLIER, currentAttempt - 1);

  return Math.min(calculatedDelay, MAX_DELAY);
}

/**
 * Spread a backoff delay out so a fleet of clients does not return in step.
 *
 * Equal jitter — half the delay fixed, half random — rather than the "full
 * jitter" of `random() * delay`. The difference matters because of what this
 * backoff is defending against: an API replica that restarts drops every
 * connection it holds at the same instant, and with full jitter a client that
 * has climbed to the 5s ceiling can still draw 12ms, so the herd never really
 * thins at the low end. FR-022's "back off rather than retry in a tight loop"
 * has to survive the randomisation, so the floor is kept at half the curve and
 * the spread is what stops the returns from being simultaneous.
 *
 * Zero stays zero. Attempt 0 is the routine token-expiry reopen, and jittering
 * it would reintroduce the every-15-minutes gap `backoffDelay` exists to avoid.
 *
 * `random` is a parameter so the tests can pin the draw instead of stubbing a
 * global; the default keeps every caller unaware of it.
 */
export function applyJitter(delay: number, random: () => number = Math.random): number {
  // Also catches NaN, which fails every comparison and would otherwise reach
  // setTimeout as an immediate fire — the tight loop, arrived at sideways.
  if (!(delay > 0)) return 0;

  const draw = random();
  // A generator that returns nonsense must not turn into an unbounded or
  // negative timer; falling back to the midpoint keeps the delay on the curve.
  const bounded = Number.isFinite(draw) ? Math.min(Math.max(draw, 0), 1) : 0.5;

  const half = delay / 2;
  return Math.round(half + half * bounded);
}

/** The frame name the server uses for its keep-alive (contracts/api.md). */
const HEARTBEAT_EVENT = 'heartbeat';

/**
 * Must match `interval(15_000)` in `apps/api/src/events/events.controller.ts`.
 *
 * Not imported from there, and deliberately not shared: the server's interval
 * is set by CloudFront's 30s `origin_read_timeout` default (research #9), while
 * this is the client's tolerance for silence. They agree today for a reason,
 * but they answer to different constraints and a shared constant would hide
 * that the day one of them has to move.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * How long a connection may go quiet before it is declared dead.
 *
 * Two intervals, per contracts/api.md — which is exactly one missed beat of
 * slack, since the clock restarts on every frame. One interval would kill a
 * healthy stream over a single late packet; three would leave a screen showing
 * stale data as live for three quarters of a minute.
 */
const LIVENESS_TIMEOUT_MS = 2 * HEARTBEAT_INTERVAL_MS;

/**
 * What a screen may say about the channel, per data-model.md "Channel status".
 *
 * `live` is derived from the heartbeat, never from the socket: a stream cut by
 * an intermediary leaves a socket that looks open and will never deliver again
 * (research #9), and a screen trusting that is precisely the stale-data-as-live
 * case FR-025 forbids.
 */
export type ChannelStatus = 'connecting' | 'live' | 'offline';

/**
 * How long a connection must last to count as healthy and clear the backoff.
 *
 * A third of the heartbeat interval: anything shorter never saw a single
 * keep-alive, so it did no useful work no matter how it ended. Long enough that
 * a routine token-expiry close — which can land seconds after connecting if the
 * token was nearly spent — costs at most one backoff step, and the next
 * connection carries a fresh token.
 */
const MIN_HEALTHY_CONNECTION_MS = 5000;

/**
 * How long a run of failures may last before the client stops retrying.
 *
 * Bounded by elapsed time rather than by a count of attempts, because an
 * attempt's cost is not fixed: a refused connection fails in milliseconds while
 * one swallowed by a captive portal can hang for thirty seconds, so the same
 * attempt count spans ten minutes or an hour depending on how the network is
 * broken. Only a clock bounds both the same way.
 *
 * Thirty minutes is chosen against SC-007, which requires recovery after an
 * interruption of up to five minutes: the budget has to clear that by enough
 * that a slightly longer outage is still ridden out, not abandoned. Well short
 * of a lunch break, which is what `resume` below is for.
 */
const GIVE_UP_AFTER_MS = 30 * 60_000;

export interface EventStreamHandlers {
  /** One parsed notification. Called once per settled, created, deleted or analytics frame. */
  onNotification: (notification: ChangeNotification) => void;
  /**
   * Called for every heartbeat frame.
   *
   * A seam for T043, which derives liveness from these: no traffic for more
   * than two intervals means the channel is not healthy, whatever the socket
   * claims (FR-025). Optional so T018 works without it.
   */
  onHeartbeat?: () => void;
  /**
   * Called on every change of channel status, and never twice with the same
   * value — a consumer can render it directly without deduplicating.
   *
   * Not an error channel: `offline` is a fact about delivery, not a failure,
   * and FR-026 is explicit that losing the channel must not read as one. This
   * is the whole of what a screen needs to satisfy FR-025, which is why the
   * three values are produced here rather than reassembled by the store —
   * only this module sees all three inputs at once (whether a socket is open,
   * whether the heartbeat is arriving, and whether retrying has been
   * abandoned), and any two of them are not enough to name the state.
   */
  onStatus?: (status: ChannelStatus) => void;
}

/** Resolves after `ms`, or as soon as `signal` aborts — a pending backoff must not delay a stop. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // The listener is removed on the ordinary path too, not only by `once`.
    // `once` fires on abort, which for a channel that is working never happens,
    // so without this every backoff leaves a dead listener on a signal that
    // lives as long as the stream — hundreds of them across a long outage, and
    // Node starts warning about a leak somewhere around ten.
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * `AbortError` arrives as a DOMException in browsers and as a plain Error in
 * some runtimes, so match on the name rather than the constructor.
 */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * Open the notification channel and keep it open.
 *
 * Returns synchronously with a stop function — the caller needs something to
 * hold immediately, not after the first connection resolves.
 *
 * Reconnection is normal operation here, not error recovery: the access token
 * lives 15 minutes and the server closes the stream when it expires (FR-006),
 * so a healthy channel is reopened several times an hour. What clears the
 * backoff is therefore how long a connection *lasted*, not whether opening it
 * succeeded — see the note in `run()` for why the obvious alternative produces
 * a tight loop.
 *
 * Retrying is bounded: after thirty minutes in which nothing connected the loop
 * stops, and `online` or the tab becoming visible starts it again. Nothing here
 * throws or blocks at any point in that — every screen keeps working off its own
 * fetches whether this channel is up, down, or abandoned (FR-026).
 *
 * Throughout, `onStatus` reports which of the three it is, with `live` earned by
 * an arriving heartbeat rather than by an open socket.
 *
 * Call order, since this spans three functions that never call each other
 * directly: `start` → `run` (loop: `sleep` → `connectAndRead` → `dispatch` per
 * frame) → `giveUp` on a long enough failure run → the listeners it registers →
 * `resume` → `start` again. The returned stop function short-circuits all of it.
 */
export function startEventStream(handlers: EventStreamHandlers): () => void {
  const abortController = new AbortController();
  const { signal } = abortController;
  let stopped = false;
  let attempt = 0;
  /** When the current run of failures began, or null while the channel is healthy. */
  let failingSince: number | null = null;
  let gaveUp = false;
  /** Last value handed to `onStatus`; null until the first one is sent. */
  let status: ChannelStatus | null = null;

  function setStatus(next: ChannelStatus): void {
    if (status === next) return;
    status = next;
    handlers.onStatus?.(next);
  }

  function dispatch(frame: SseFrame): void {
    if (frame.event === HEARTBEAT_EVENT) {
      handlers.onHeartbeat?.();
      return;
    }

    // Anything we do not recognise is ignored rather than guessed at — the set
    // of notification types is closed, and a new one reaching an old client
    // should do nothing rather than something arbitrary.
    if (!isNotificationType(frame.event)) return;

    let notification: ChangeNotification;
    try {
      notification = JSON.parse(frame.data) as ChangeNotification;
    } catch {
      // Dropped, never rethrown: one malformed payload must not take down a
      // channel that is otherwise working. This is the case the parser
      // deliberately left to this layer — a pure function had no good answer
      // to a throw, and this one does.
      console.warn('[events] discarding malformed notification', frame);
      return;
    }

    handlers.onNotification(notification);
  }

  /** Opens one connection and reads it to completion. Returns on a clean close. */
  async function connectAndRead(): Promise<void> {
    // This connection gets its own controller, chained to the stream's. Two
    // things must be able to drop it and only one of them ends the stream: the
    // caller's stop (via `signal`), and the quiet watchdog below, which drops
    // *this* connection precisely so the loop can open another.
    const connection = new AbortController();
    const abortConnection = (): void => connection.abort();
    signal.addEventListener('abort', abortConnection, { once: true });

    let watchdog: ReturnType<typeof setTimeout> | undefined;

    /**
     * Restart the quiet timer.
     *
     * Petted by *bytes*, not by frames. Our own server opens with a blank line
     * before it has anything to say, and a notification split across two reads
     * arrives as two chunks of which only the second parses — both are the
     * socket demonstrably working, and FR-025's rule is about traffic.
     *
     * `live` is a stricter claim and is set on a parsed frame instead: the
     * opening blank line proves a socket exists, which is exactly the evidence
     * research #9 says not to trust.
     */
    function noteTraffic(): void {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        // Nothing has "failed" here in any way the socket can report — which is
        // the entire point. An intermediary cut the stream and left us holding
        // an open connection that will never deliver again, so the only way
        // back is to drop it ourselves and let `run` open a fresh one.
        console.warn('[events] no traffic for two heartbeat intervals; reconnecting');
        setStatus('offline');
        connection.abort();
      }, LIVENESS_TIMEOUT_MS);
    }

    try {
      const response = await apiFetch('/events', {
        headers: { accept: 'text/event-stream' },
        signal: connection.signal,
      });

      // apiFetch resolves for any status — only apiJson throws — so without
      // this a 429 (per-user cap) or 503 (backend unavailable) would be read as
      // if it were an event stream, yield no frames, and end in silence. The
      // server distinguishes those two deliberately; discarding that here would
      // waste it.
      if (!response.ok || !response.body) {
        throw new ApiError(response.status, await response.text().catch(() => undefined));
      }

      // The clock starts at the response, not at the first chunk: a server that
      // completes the handshake and then says nothing at all is the case with
      // no other symptom, and starting the timer later would never catch it.
      noteTraffic();

      // pipeThrough(TextDecoderStream) rather than a hand-held TextDecoder:
      // UTF-8 is variable-length, so a chunk boundary can land mid-character
      // and split a Cyrillic exercise name into two replacement chars. The
      // transform keeps the partial bytes internally, which makes forgetting
      // `{ stream: true }` structurally impossible.
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';

      for (;;) {
        // infinity loop
        const { value, done } = await reader.read();
        if (done) return; // server closed the stream — expected at token expiry
        if (stopped) return;

        noteTraffic();

        const { frames, rest } = parseFrames(buffer, value);
        buffer = rest;

        for (const frame of frames) {
          // Before dispatching, not after: a consumer that refetches on a
          // notification should already be able to see the channel is live.
          setStatus('live');
          dispatch(frame);
        }
      }
    } finally {
      clearTimeout(watchdog);
      signal.removeEventListener('abort', abortConnection);
    }
  }

  async function run(): Promise<void> {
    while (!stopped && !gaveUp) {
      // `attempt` is 0 both on the very first try and on the reconnect after a
      // healthy connection ended, which is exactly data-model.md's `connecting`
      // — "first attempt, or reconnecting after a drop". From the first failure
      // onward the optimism is unearned: nothing is arriving and the screen has
      // to be able to say so (FR-025).
      setStatus(attempt === 0 ? 'connecting' : 'offline');

      await sleep(applyJitter(backoffDelay(attempt)), signal);
      if (stopped) return;

      // Started *after* the backoff, not before it. An earlier version opened
      // the window around the sleep as well, and the arithmetic then quietly
      // inverted itself: once the delay reached the 5s ceiling it alone met
      // MIN_HEALTHY_CONNECTION_MS, so every cycle scored as healthy however
      // fast the connection failed, the counter reset to 0, and a permanent
      // outage cycled 0→250→…→5000 forever instead of settling at the ceiling.
      // It also meant `failingSince` cleared on each lap, so the give-up below
      // could never be reached at all.
      const startedAt = Date.now();

      try {
        await connectAndRead();
      } catch (err) {
        // `stopped`, not `isAbortError`, is what ends the loop. Both the
        // caller's stop and the quiet watchdog abort this connection, and only
        // the first of them means the stream is over — keying on the error
        // would let a watchdog reconnect silently kill the stream instead.
        if (stopped) return;

        // The watchdog logs its own reason before aborting, so there is nothing
        // to add here beyond what it already said.
        if (!isAbortError(err)) console.warn('[events] stream failed', err);
      }

      // How long the connection *lasted* decides whether it counted, not
      // whether opening it succeeded. An earlier draft reset the counter the
      // moment a connection was established, which looked right — a healthy
      // channel that drops should come back at once — but a server that
      // accepts and immediately closes made every cycle a "success", pinning
      // the delay at zero and hammering it in a tight loop. A test caught it
      // reopening 123 times in 150ms; FR-022 forbids exactly that.
      //
      // Judging by duration also collapses two rules into one: a long-lived
      // stream that errors mid-flight reconnects immediately, while anything
      // short-lived backs off, however it ended.
      if (Date.now() - startedAt >= MIN_HEALTHY_CONNECTION_MS) {
        attempt = 0;
        failingSince = null;
        continue;
      }

      attempt += 1;
      failingSince ??= startedAt;
      if (Date.now() - failingSince >= GIVE_UP_AFTER_MS) giveUp();
    }
  }

  function start(): void {
    if (!stopped) void run();
  }

  /**
   * Stop retrying, and arrange to be woken.
   *
   * Retrying a dead network every five seconds forever is not free — it is a
   * timer and a failing request per client per five seconds — and after half an
   * hour the odds that the next attempt is the one that works are poor. What
   * makes stopping safe rather than terminal is that the two events which
   * actually change those odds both fire: `online` when the interface comes
   * back, and a tab becoming visible again, which is the shape of the case that
   * would otherwise strand a user — a laptop closed overnight, where nothing
   * was ever wrong with the network because there was no network at all.
   */
  function giveUp(): void {
    gaveUp = true;
    console.warn('[events] reconnects abandoned after 30m; resuming if the network or tab returns');
    setStatus('offline');
    resumeListeners('add');
  }

  function resume(): void {
    // `gaveUp` is what makes this safe to call twice, which matters because
    // waking a laptop fires `online` and `visibilitychange` within a frame of
    // each other. It is also why `start()` needs no guard of its own against a
    // second loop: `giveUp` sets the flag and the loop condition reads it in
    // the same synchronous stretch, so by the time any listener can run, `run`
    // has already returned — there is never a loop still live to double.
    if (stopped || !gaveUp) return;

    resumeListeners('remove');
    gaveUp = false;
    // Attempt 0 is deliberate: whatever woke us is evidence the world changed,
    // so the first try after it should be immediate rather than paying out the
    // ceiling the previous half hour of failures had earned.
    attempt = 0;
    failingSince = null;
    start();
  }

  function resumeIfVisible(): void {
    if (document.visibilityState === 'visible') resume();
  }

  /**
   * Both listeners in one place so `stop()` cannot remove a subset.
   *
   * Guarded on the globals rather than assumed: this module is imported into a
   * Next app that also renders on the server and is unit-tested under vitest's
   * `node` environment, and in neither does `window` exist. Nothing is lost
   * there — no stream is opened on the server to give up on.
   */
  function resumeListeners(op: 'add' | 'remove'): void {
    if (typeof window !== 'undefined') {
      if (op === 'add') window.addEventListener('online', resume);
      else window.removeEventListener('online', resume);
    }
    if (typeof document !== 'undefined') {
      if (op === 'add') document.addEventListener('visibilitychange', resumeIfVisible);
      else document.removeEventListener('visibilitychange', resumeIfVisible);
    }
  }

  start();

  return () => {
    stopped = true;
    resumeListeners('remove');
    abortController.abort();
  };
}
