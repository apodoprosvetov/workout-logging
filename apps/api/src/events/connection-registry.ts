import { Injectable, MessageEvent } from '@nestjs/common';
import { Subject } from 'rxjs';

/**
 * A granted connection slot.
 *
 * `isFirstForUser` exists for the subscriber (T009): the Redis channel for a
 * user should be subscribed to when their *first* stream opens, not once per
 * stream. Returning it here rather than exposing a `hasConnections()` query
 * keeps that decision on one lookup instead of two, and removes the window
 * between asking and acting.
 */
export interface ConnectionSlot {
  stream: Subject<MessageEvent>;
  isFirstForUser: boolean;
}

/**
 * The SSE connections this replica is holding, per user.
 *
 * **Nothing calls this directly except NotificationsSubscriber.** It is
 * bookkeeping, not a service other code reaches for; the subscriber owns the
 * Redis connection and therefore owns the decisions about when to touch this.
 * Kept a separate class only so these properties — the cap, the leak, the
 * transitions — can be exercised with no Redis and no Nest lifecycle.
 *
 * When each method runs, which is the part that is easy to get backwards:
 *
 * ```
 * client opens GET /api/events  → subscriber.openStream()  → register()
 * client disconnects (teardown) → subscriber.closeStream() → unregister()
 * worker publishes to Redis     → subscriber.handleMessage() → broadcast()
 * ```
 *
 * The first two run once per HTTP connection. The third runs once per incoming
 * message, no matter how many connections are open. `broadcast` never
 * registers anything — a message arriving is not a client arriving, and
 * conflating the two creates streams nobody is listening to.
 *
 * Deliberately per-replica and not shared: it describes sockets owned by *this*
 * process, which no other replica can write to. Caddy round-robins across
 * api-1 and api-2 (infra/Caddyfile), so each holds its own disjoint set — the
 * fan-out that gets a notification to whichever replica holds a given
 * connection is Redis Pub/Sub's job, not this registry's.
 *
 * Empty at process start and never persisted. A restart drops its connections;
 * clients reconnect and resync (FR-022, FR-023).
 */
@Injectable()
export class ConnectionRegistry {
  private readonly registry = new Map<string, Set<Subject<MessageEvent>>>();

  // Per *replica*, so the real ceiling for one user is this times the number of
  // replicas — two today. That is accepted rather than overlooked: the goal is
  // to stop one user exhausting a process, not exact global accounting, which
  // would need shared state this registry deliberately avoids (FR-028,
  // research #10).
  private readonly MAX_CONNECTIONS_PER_USER = 10;

  /**
   * Grant a stream, or refuse with `null` when the user is at the cap.
   *
   * The cap check and the insert are one operation on purpose: split into a
   * separate count-then-add, the two could be called from different places and
   * the limit would quietly stop holding.
   */
  register(userId: string): ConnectionSlot | null {
    const existing = this.registry.get(userId);

    if (existing && existing.size >= this.MAX_CONNECTIONS_PER_USER) {
      return null;
    }

    // Only create the entry once the slot is actually granted — an entry
    // created before the check would survive a refusal as an orphan.
    const userStreams = existing ?? new Set<Subject<MessageEvent>>();
    if (!existing) {
      this.registry.set(userId, userStreams);
    }

    const stream = new Subject<MessageEvent>();
    userStreams.add(stream);

    return { stream, isFirstForUser: userStreams.size === 1 };
  }

  /**
   * Push an event into every stream this replica holds for one user, and return
   * how many received it.
   *
   * The fan-out lives here rather than handing the set out through a getter:
   * the set stays private, so nothing outside can add a stream and slip past
   * the cap that `register` enforces. It also keeps "a user's notifications
   * reach only that user's streams" (FR-005) verifiable in one place.
   *
   * A return of 0 is normal, not an error — with two replicas, a user's
   * connections may all live on the other one, and a notification with no
   * listener is simply dropped (FR-027).
   */
  broadcast(userId: string, event: MessageEvent): number {
    const userStreams = this.registry.get(userId);
    if (!userStreams) return 0;

    // Iterate a copy: `next()` can synchronously run a subscriber's teardown,
    // which calls unregister() and mutates this very set mid-iteration. Same
    // hazard the web client already documents in services/workout-events.ts.
    const streams = [...userStreams];
    for (const stream of streams) stream.next(event);

    return streams.length;
  }

  /**
   * Release a stream. Returns whether it was the user's last one, which is the
   * subscriber's cue to unsubscribe from their Redis channel (T009).
   *
   * Called from the connection's own teardown — never from a sweep or a timer.
   * The T003 spike confirmed `@Sse()` runs the Observable's teardown when the
   * client goes away, which is what makes a sweep unnecessary and keeps a
   * vanished client from leaking an entry (FR-027).
   */
  unregister(userId: string, subject: Subject<MessageEvent>): boolean {
    const userStreams = this.registry.get(userId);
    if (!userStreams) return false;

    userStreams.delete(subject);
    subject.complete();

    // Drop the key with the last stream. Leaving an empty Set behind would grow
    // the map by one entry per user who has *ever* connected, with nothing to
    // ever remove it — a slow leak in a process meant to run for weeks.
    if (userStreams.size === 0) {
      this.registry.delete(userId);
      return true;
    }

    return false;
  }
}
