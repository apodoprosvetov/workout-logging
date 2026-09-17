import { Injectable, MessageEvent } from '@nestjs/common';
import { Subject } from 'rxjs';

/**
 * A granted connection slot. `isFirstForUser` tells the subscriber when to
 * subscribe to the user's Redis channel — returned here rather than exposed as
 * a query, so there is no window between asking and acting.
 */
export interface ConnectionSlot {
  stream: Subject<MessageEvent>;
  isFirstForUser: boolean;
}

/**
 * The SSE connections this replica holds, per user. Only NotificationsSubscriber
 * calls it; a separate class so the cap and the leak can be tested with no Redis.
 *
 * ```
 * client opens GET /api/events  → subscriber.openStream()    → register()
 * client disconnects (teardown) → subscriber.closeStream()   → unregister()
 * worker publishes to Redis     → subscriber.handleMessage() → broadcast()
 * ```
 *
 * The first two run once per connection, the third once per message.
 * **`broadcast` never registers anything** — a message arriving is not a client
 * arriving, and conflating them creates streams nobody listens to.
 *
 * Per-replica by design: it describes sockets this process owns. Caddy
 * round-robins across api-1/api-2, so getting a notification to the right
 * replica is Redis Pub/Sub's job. A restart drops everything; clients reconnect
 * and resync (FR-022, FR-023).
 */
@Injectable()
export class ConnectionRegistry {
  private readonly registry = new Map<string, Set<Subject<MessageEvent>>>();

  // Per replica, so one user's real ceiling is this times the replica count.
  // Accepted: the goal is protecting a process, not exact global accounting,
  // which would need shared state (FR-028, research #10).
  private readonly MAX_CONNECTIONS_PER_USER = 10;

  /**
   * Grant a stream, or `null` at the cap. Check and insert are one operation —
   * split into count-then-add, the limit would quietly stop holding.
   */
  register(userId: string): ConnectionSlot | null {
    const existing = this.registry.get(userId);

    if (existing && existing.size >= this.MAX_CONNECTIONS_PER_USER) {
      return null;
    }

    // Created only once the slot is granted; earlier would orphan it on refusal.
    const userStreams = existing ?? new Set<Subject<MessageEvent>>();
    if (!existing) {
      this.registry.set(userId, userStreams);
    }

    const stream = new Subject<MessageEvent>();
    userStreams.add(stream);

    return { stream, isFirstForUser: userStreams.size === 1 };
  }

  /**
   * Push an event into this replica's streams for one user; returns how many
   * got it. Fan-out lives here so the set stays private and nothing can add a
   * stream past `register`'s cap, and so FR-005 is checkable in one place.
   *
   * 0 is normal: the user's connections may all be on the other replica, and a
   * notification with no listener is dropped (FR-027).
   */
  broadcast(userId: string, event: MessageEvent): number {
    const userStreams = this.registry.get(userId);
    if (!userStreams) return 0;

    // Copy: `next()` can synchronously run a teardown that calls unregister()
    // and mutates this set mid-iteration.
    const streams = [...userStreams];
    for (const stream of streams) stream.next(event);

    return streams.length;
  }

  /**
   * Release a stream; returns whether it was the user's last — the subscriber's
   * cue to unsubscribe from Redis.
   *
   * Driven by the connection's own teardown, never a sweep: `@Sse()` runs the
   * Observable's teardown when the client goes away, so a vanished client
   * cannot leak an entry (FR-027).
   */
  unregister(userId: string, subject: Subject<MessageEvent>): boolean {
    const userStreams = this.registry.get(userId);
    if (!userStreams) return false;

    userStreams.delete(subject);
    subject.complete();

    // Drop the key with the last stream: an empty Set per user who ever
    // connected is a slow leak in a process that runs for weeks.
    if (userStreams.size === 0) {
      this.registry.delete(userId);
      return true;
    }

    return false;
  }
}
