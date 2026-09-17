import {
  ChangeNotification,
  createRedisSubscriber,
  getEventsChannelName,
} from '@workout-logging/shared';

import type Redis from 'ioredis';

/**
 * Listens on one user's notification channel for the length of a test.
 *
 * Subscribes on its own connection rather than reusing the app's: ioredis puts
 * a client into subscriber mode on the first `subscribe()` and then rejects
 * every ordinary command on it, so borrowing the injected REDIS_CLIENT would
 * break the very publish under test.
 *
 * Reads the user id out of the access token rather than querying Postgres for
 * it — the channel is named after the token's subject (FR-005), so taking it
 * from anywhere else would test a different user than the request will.
 */
export class NotificationListener {
  private readonly received: ChangeNotification[] = [];
  private constructor(
    private readonly subscriber: Redis,
    readonly userId: string,
  ) {}

  static async open(accessToken: string): Promise<NotificationListener> {
    const userId = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString())
      .sub as string;

    const subscriber = createRedisSubscriber();
    const listener = new NotificationListener(subscriber, userId);
    subscriber.on('message', (_channel: string, payload: string) => {
      listener.received.push(JSON.parse(payload) as ChangeNotification);
    });
    await subscriber.subscribe(getEventsChannelName(userId));
    return listener;
  }

  /**
   * Resolves with the first notification matching `predicate`, or null if none
   * arrives in time.
   *
   * Polls rather than racing a one-shot handler so a notification that landed
   * *before* this was called still counts — publishing and asserting are
   * separate awaits in a test, and the channel does not wait for the assertion.
   */
  async waitFor(
    predicate: (n: ChangeNotification) => boolean,
    timeoutMs = 5000,
  ): Promise<ChangeNotification | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.received.find(predicate);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.received.find(predicate) ?? null;
  }

  /** Everything seen so far — for asserting a notification did *not* arrive. */
  all(): readonly ChangeNotification[] {
    return this.received;
  }

  close(): void {
    this.subscriber.disconnect();
  }
}
