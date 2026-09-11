import { Injectable, Logger, MessageEvent, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import {
  ChangeNotification,
  createRedisSubscriber,
  getEventsChannelName,
  getUserIdFromEventsChannel,
} from '@workout-logging/shared';

import { ConnectionRegistry } from './connection-registry';

import type Redis from 'ioredis';
import type { Subject } from 'rxjs';

/**
 * Receives change notifications from Redis and routes them to the SSE streams
 * this replica is holding.
 *
 * Two independent paths meet here, and they never call each other:
 *
 * - **Opening and closing streams** — driven by clients connecting to
 *   `GET /api/events`. One call per HTTP connection.
 * - **Delivering notifications** — driven by the worker publishing. One call
 *   per incoming Redis message, however many streams are open.
 *
 * The Redis channel is per user while connections are many per user, so the
 * subscribe/unsubscribe pair is tied to the registry's 0→1 and 1→0 transitions
 * rather than to each connection.
 */
@Injectable()
export class NotificationsSubscriber implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsSubscriber.name);

  // One connection for the whole process, carrying every channel this replica
  // needs. Not one per user: with SC-010's 200 concurrent streams that would
  // mean 200 Redis connections per replica, and 200 separate reconnect stories.
  // ioredis re-subscribes to all of a connection's channels after a drop, which
  // is what makes a single connection survivable.
  private redis!: Redis;

  constructor(private readonly registry: ConnectionRegistry) {}

  onModuleInit(): void {
    this.redis = createRedisSubscriber();

    this.redis.on('message', (channel: string, message: string) => {
      this.handleMessage(channel, message);
    });

    // Connection-level failures are logged but never thrown: losing the
    // subscriber must not take the API down. Clients notice through the
    // heartbeat and resync on reconnect (FR-025, FR-023).
    this.redis.on('error', (err: Error) => {
      this.logger.error('notification subscriber connection error', err.stack);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit();
  }

  /**
   * Open a stream for a connecting client.
   *
   * Returns `null` when the user is already at this replica's cap — the caller
   * turns that into `429`. A failure to subscribe throws instead, because the
   * two mean different things to the client: `null` is "too many of your own
   * connections", a throw is "this replica cannot serve notifications right
   * now" (`503` per contracts/api.md).
   */
  async openStream(userId: string): Promise<Subject<MessageEvent> | null> {
    const slot = this.registry.register(userId);
    if (!slot) {
      this.logger.warn(`connection refused, per-replica cap reached: user=${userId}`);
      return null;
    }

    if (slot.isFirstForUser) {
      try {
        await this.redis.subscribe(getEventsChannelName(userId));
        this.logger.log(`subscribed to notifications: user=${userId}`);
      } catch (err) {
        // Release the slot rather than leave a stream that can never receive
        // anything — a silently dead connection is worse than a refused one.
        this.registry.unregister(userId, slot.stream);
        throw err;
      }
    }

    this.logger.log(`stream opened: user=${userId}`);
    return slot.stream;
  }

  /**
   * Release a stream when its client goes away.
   *
   * Called from the SSE Observable's teardown, which the T003 spike confirmed
   * fires on client disconnect — that is what makes a periodic sweep
   * unnecessary (FR-027).
   */
  async closeStream(userId: string, stream: Subject<MessageEvent>): Promise<void> {
    const wasLast = this.registry.unregister(userId, stream);
    this.logger.log(`stream closed: user=${userId} wasLast=${wasLast}`);

    if (!wasLast) return;

    try {
      await this.redis.unsubscribe(getEventsChannelName(userId));
      this.logger.log(`unsubscribed from notifications: user=${userId}`);
    } catch (err) {
      // The client is already gone; a failed unsubscribe leaves a channel this
      // replica no longer needs, which costs nothing but a wasted delivery.
      // Not worth propagating into a teardown path.
      this.logger.error(
        `failed to unsubscribe: user=${userId}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  private handleMessage(channel: string, message: string): void {
    // Read the channel back through the inverse of the function that built it,
    // so the format stays defined in exactly one place.
    const userId = getUserIdFromEventsChannel(channel);
    if (!userId) {
      this.logger.warn(`ignoring message from unrecognised channel: ${channel}`);
      return;
    }

    let notification: ChangeNotification;
    try {
      notification = JSON.parse(message) as ChangeNotification;
    } catch (err) {
      // One handler serves every stream on this replica, so an uncaught throw
      // here would stop delivery for everyone. Drop the bad message instead.
      this.logger.error(
        `malformed notification on ${channel}`,
        err instanceof Error ? err.stack : undefined,
      );
      return;
    }

    // `data` is the exact string that came off Redis, not a re-serialised
    // object: Nest passes a string through untouched, so there is one
    // serialisation of the envelope and no chance of drifting from
    // contracts/events.md. `type` becomes the SSE event name, per
    // contracts/api.md.
    const delivered = this.registry.broadcast(userId, {
      data: message,
      type: notification.type,
    });

    this.logger.debug?.(
      `delivered ${notification.type} event=${notification.event_id} ` +
        `user=${userId} streams=${delivered}`,
    );
  }
}
