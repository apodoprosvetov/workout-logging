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

/** The frame name the server uses for its keep-alive (contracts/api.md). */
const HEARTBEAT_EVENT = 'heartbeat';

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
}

/** Resolves after `ms`, or as soon as `signal` aborts — a pending backoff must not delay a stop. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
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
 */
export function startEventStream(handlers: EventStreamHandlers): () => void {
  const abortController = new AbortController();
  const { signal } = abortController;
  let stopped = false;
  let attempt = 0;

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
    const response = await apiFetch('/events', {
      headers: { accept: 'text/event-stream' },
      signal,
    });

    // apiFetch resolves for any status — only apiJson throws — so without this
    // a 429 (per-user cap) or 503 (backend unavailable) would be read as if it
    // were an event stream, yield no frames, and end in silence. The server
    // distinguishes those two deliberately; discarding that here would waste it.
    if (!response.ok || !response.body) {
      throw new ApiError(response.status, await response.text().catch(() => undefined));
    }

    // pipeThrough(TextDecoderStream) rather than a hand-held TextDecoder: UTF-8
    // is variable-length, so a chunk boundary can land mid-character and split
    // a Cyrillic exercise name into two replacement chars. The transform keeps
    // the partial bytes internally, which makes forgetting `{ stream: true }`
    // structurally impossible.
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';

    for (;;) {
      // infinity loop
      const { value, done } = await reader.read();
      if (done) return; // server closed the stream — expected at token expiry
      if (stopped) return;

      const { frames, rest } = parseFrames(buffer, value);
      buffer = rest;

      for (const frame of frames) dispatch(frame);
    }
  }

  async function run(): Promise<void> {
    while (!stopped) {
      const startedAt = Date.now();

      try {
        await sleep(backoffDelay(attempt), signal);
        if (stopped) return;

        await connectAndRead();
      } catch (err) {
        // Our own stop, not a failure. Nothing to log, nothing to retry.
        if (stopped || isAbortError(err)) return;

        console.warn('[events] stream failed', err);
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
      attempt = Date.now() - startedAt >= MIN_HEALTHY_CONNECTION_MS ? 0 : attempt + 1;
    }
  }

  void run();

  return () => {
    stopped = true;
    abortController.abort();
  };
}
