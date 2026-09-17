import { ApiError, apiFetch } from './api-client';

import type { ChangeNotification, NotificationType } from '@workout-logging/shared';

// Literals, not imports: the dependency on @workout-logging/shared is type-only
// (its barrel pulls node modules into the browser bundle), and the guard below
// needs runtime values.
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
 * One SSE frame, still as text — not a ChangeNotification, because a heartbeat
 * is a frame but not a notification, and `JSON.parse` throws, which a pure
 * function has no good answer to. The reader drops one bad message instead.
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
 * Split an SSE byte stream into complete frames. `rest` is the incomplete tail;
 * the caller feeds it back as `buffer` with the next chunk.
 *
 * **LF only — CRLF is unsupported.** Our one producer is Nest's `@Sse()`, whose
 * raw output was checked byte by byte and uses `\n`. If that ever changed the
 * failure is total silence, not a stray `\r`: `\r\n\r\n` matches no boundary
 * and the whole stream accumulates in `rest`.
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
      // A leading colon is an SSE comment (the keep-alive form). Skipped
      // explicitly rather than left to miss every switch case below.
      // `startsWith`, not "contains": `data: :x` legitimately carries `:x`.
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
  const currentAttempt = Math.max(0, attempt);

  if (currentAttempt === 0) {
    return 0;
  }

  const calculatedDelay = BASE_DELAY * Math.pow(MULTIPLIER, currentAttempt - 1);

  return Math.min(calculatedDelay, MAX_DELAY);
}

/**
 * Spread a backoff delay so a fleet of clients does not return in step.
 *
 * **Equal** jitter (half fixed, half random), not full `random() * delay`: a
 * restarting replica drops every connection at once, and full jitter lets a
 * client at the 5s ceiling still draw 12ms — the tight loop FR-022 forbids,
 * arrived at sideways. The floor is what makes the rule survive randomisation.
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
  // A nonsense generator must not become an unbounded or negative timer.
  const bounded = Number.isFinite(draw) ? Math.min(Math.max(draw, 0), 1) : 0.5;

  const half = delay / 2;
  return Math.round(half + half * bounded);
}

/** The frame name the server uses for its keep-alive (contracts/api.md). */
const HEARTBEAT_EVENT = 'heartbeat';

/**
 * Must match `interval(15_000)` in the events controller. Not shared with it on
 * purpose: the server's value answers to CloudFront's 30s read timeout
 * (research #9), this one is the client's tolerance for silence.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Two intervals (contracts/api.md) — one missed beat of slack, since the clock
 * restarts on every frame. One interval kills a healthy stream over a late
 * packet; three shows stale data as live for 45 seconds.
 */
const LIVENESS_TIMEOUT_MS = 2 * HEARTBEAT_INTERVAL_MS;

/**
 * data-model.md "Channel status". `live` comes from the heartbeat, never the
 * socket: an intermediary can cut a stream and leave a socket that looks open
 * forever (research #9) — the stale-as-live case FR-025 forbids.
 */
export type ChannelStatus = 'connecting' | 'live' | 'offline';

/**
 * How long a connection must last to clear the backoff. A third of the
 * heartbeat interval — anything shorter never saw a keep-alive, so it did no
 * work however it ended.
 */
const MIN_HEALTHY_CONNECTION_MS = 5000;

/**
 * Bounded by elapsed time, not attempt count: a refused connection fails in
 * milliseconds while one behind a captive portal hangs for thirty seconds, so
 * the same count spans ten minutes or an hour. Thirty minutes clears SC-007's
 * five-minute interruption with room to ride out a longer one.
 */
const GIVE_UP_AFTER_MS = 30 * 60_000;

export interface EventStreamHandlers {
  /** One parsed notification. Called once per settled, created, deleted or analytics frame. */
  onNotification: (notification: ChangeNotification) => void;
  /** Every heartbeat frame — the liveness signal behind FR-025. */
  onHeartbeat?: () => void;
  /**
   * Every status change, never twice with the same value, so a consumer can
   * render it directly. Not an error channel — `offline` is a fact about
   * delivery, and FR-026 forbids reading it as a failure.
   *
   * Produced here rather than in the store because only this module sees all
   * three inputs at once (socket open, heartbeat arriving, retrying abandoned),
   * and any two cannot name the state.
   */
  onStatus?: (status: ChannelStatus) => void;
}

/** Resolves after `ms`, or as soon as `signal` aborts — a pending backoff must not delay a stop. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // Removed on the ordinary path too: `once` only fires on abort, which a
    // working channel never does, so every backoff would leak a listener on a
    // signal that lives as long as the stream.
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
 * Open the notification channel and keep it open. Returns the stop function
 * synchronously, before the first connection resolves.
 *
 * Reconnection is normal operation, not error recovery: the 15-minute access
 * token expires and the server closes the stream (FR-006), several times an
 * hour. So the backoff is cleared by how long a connection *lasted*, not by
 * whether opening it succeeded — see `run()`.
 *
 * Retrying is bounded at thirty minutes; `online` or the tab becoming visible
 * restarts it. Nothing here throws or blocks — screens work off their own
 * fetches whether the channel is up, down or abandoned (FR-026).
 *
 * Call order, since these functions never call each other directly:
 * `start` → `run` (loop: `sleep` → `connectAndRead` → `dispatch` per frame)
 * → `giveUp` → its listeners → `resume` → `start`. Stop short-circuits all of it.
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

    // A type an old client does not know should do nothing, not something
    // arbitrary.
    if (!isNotificationType(frame.event)) return;

    let notification: ChangeNotification;
    try {
      notification = JSON.parse(frame.data) as ChangeNotification;
    } catch {
      // Dropped, never rethrown: one bad payload must not kill a working channel.
      console.warn('[events] discarding malformed notification', frame);
      return;
    }

    handlers.onNotification(notification);
  }

  /** Opens one connection and reads it to completion. Returns on a clean close. */
  async function connectAndRead(): Promise<void> {
    // Its own controller, chained to the stream's: two things may drop this
    // connection, and only the caller's stop ends the stream. The watchdog
    // below drops it precisely so the loop can open another.
    const connection = new AbortController();
    const abortConnection = (): void => connection.abort();
    signal.addEventListener('abort', abortConnection, { once: true });

    let watchdog: ReturnType<typeof setTimeout> | undefined;

    /**
     * Restart the quiet timer. Petted by *bytes*, not frames: the server opens
     * with a blank line and a split notification arrives as two chunks, both of
     * which prove traffic. `live` is stricter and needs a parsed frame.
     */
    function noteTraffic(): void {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        // Nothing failed in any way the socket can report — that is the point.
        // Dropping it ourselves is the only way back.
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

      // Starts at the response, not the first chunk: a server that completes the
      // handshake then says nothing has no other symptom.
      noteTraffic();

      // TextDecoderStream, not a hand-held TextDecoder: it keeps partial bytes
      // internally, so a chunk boundary mid-character cannot mangle a Cyrillic
      // exercise name.
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';

      for (;;) {
        const { value, done } = await reader.read();
        if (done) return; // server closed the stream — expected at token expiry
        if (stopped) return;

        noteTraffic();

        const { frames, rest } = parseFrames(buffer, value);
        buffer = rest;

        for (const frame of frames) {
          // Before dispatching: a consumer refetching on a notification should
          // already see the channel as live.
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
      // Attempt 0 covers both the first try and the reconnect after a healthy
      // connection — data-model.md's `connecting`. After a failure the optimism
      // is unearned and the screen must be able to say so (FR-025).
      setStatus(attempt === 0 ? 'connecting' : 'offline');

      await sleep(applyJitter(backoffDelay(attempt)), signal);
      if (stopped) return;

      // After the backoff, not before: including the sleep meant that at the 5s
      // ceiling the sleep alone met MIN_HEALTHY_CONNECTION_MS, so every failing
      // cycle scored as healthy and the delay sawtoothed back to zero forever.
      const startedAt = Date.now();

      try {
        await connectAndRead();
      } catch (err) {
        // `stopped`, not `isAbortError`: the watchdog aborts with the same
        // error, and keying on it would let a reconnect kill the stream.
        if (stopped) return;

        // The watchdog already logged its reason.
        if (!isAbortError(err)) console.warn('[events] stream failed', err);
      }

      // Duration, not success, decides whether a connection counted: resetting
      // on connect let a server that accepts and immediately closes pin the
      // delay at zero — 123 reopens in 150ms, the tight loop FR-022 forbids.
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
   * Stop retrying, and arrange to be woken. Safe rather than terminal because
   * the two events that change the odds both fire: `online`, and a tab becoming
   * visible — the laptop-closed-overnight case that would otherwise strand a user.
   */
  function giveUp(): void {
    gaveUp = true;
    console.warn('[events] reconnects abandoned after 30m; resuming if the network or tab returns');
    setStatus('offline');
    resumeListeners('add');
  }

  function resume(): void {
    // Safe to call twice: waking a laptop fires `online` and `visibilitychange`
    // together. Also why `start()` needs no guard — `giveUp` sets the flag and
    // the loop reads it synchronously, so `run` has returned before any listener.
    if (stopped || !gaveUp) return;

    resumeListeners('remove');
    gaveUp = false;
    // Attempt 0: whatever woke us is evidence the world changed, so do not pay
    // out the ceiling the last half hour earned.
    attempt = 0;
    failingSince = null;
    start();
  }

  function resumeIfVisible(): void {
    if (document.visibilityState === 'visible') resume();
  }

  /**
   * Both listeners in one place so `stop()` cannot remove a subset. Globals are
   * guarded because this module loads under Next's server render and vitest's
   * `node` environment, where no stream exists to give up on anyway.
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
