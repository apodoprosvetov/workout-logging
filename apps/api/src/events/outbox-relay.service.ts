import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { RabbitMqPublisherService } from './rabbitmq-publisher.service';

/** How long to wait between sweeps when the last one found nothing. */
const IDLE_POLL_MS = 1000;

/**
 * How many events one sweep takes.
 *
 * The batch is held under a row lock for as long as it takes to publish, so
 * this is really "how long may one replica hold a slice of the queue". Fifty
 * confirmed publishes is well under a second against a healthy broker, and a
 * smaller number would just mean more sweeps to drain a backlog.
 */
const BATCH_SIZE = 50;

/**
 * Publishes committed outbox events to RabbitMQ.
 *
 * The second half of the transactional outbox: T058 writes the event to
 * Postgres in the same transaction as the state it describes, and this puts it
 * on the exchange afterwards. Nothing in the request path publishes any more,
 * so **if this service is not running, no workout is ever parsed** — it is not
 * a background nicety, it is the only link between the API and the worker.
 *
 * Call order:
 *
 * ```
 * onModuleInit -> loop() -> sweep() --(rows?)--> publish + mark -> sweep() again
 *                             |                                      immediately
 *                             `--(none)--> wait IDLE_POLL_MS -> sweep()
 * onModuleDestroy -> stop the loop, let the sweep in flight finish
 * ```
 *
 * **At-least-once, never at-most-once.** A row is marked published only after
 * the broker acknowledges it (T054's confirm channel), so a crash between the
 * publish and the `UPDATE` re-sends the event on the next sweep. That is the
 * safe direction to fail: consumers already dedupe through
 * `withEventIdempotency` and the `processed_events` table, which spec 001 paid
 * for and this reuses — half the usual cost of an outbox, already on the shelf.
 */
@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private running = false;
  /** The loop itself, awaited on shutdown so a sweep is never cut mid-batch. */
  private loop: Promise<void> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Ends the current idle wait early. Null while the loop is not sleeping. */
  private wake: (() => void) | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly publisher: RabbitMqPublisherService,
  ) {}

  onModuleInit(): void {
    this.running = true;
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    // Wake the loop if it is sleeping, so shutdown does not wait out a poll.
    //
    // `wake()`, not a bare `clearTimeout`: cancelling the timer only stops the
    // callback, and the callback is what resolves the sleep — so clearing it
    // alone leaves the promise pending forever and `await this.loop` below
    // never returns. Shutdown hung until a test timed out on it.
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let published = 0;
      try {
        published = await this.sweep();
      } catch (err) {
        // Never let the loop die. A broker outage, a lost Postgres connection
        // — all of it is transient from here, and a relay that exited on the
        // first failure would silently stop the whole pipeline with the API
        // still reporting healthy.
        this.logger.error(
          'outbox sweep failed; retrying',
          err instanceof Error ? err.stack : undefined,
        );
      }

      // A full batch means there is probably more waiting, so drain without
      // pausing; anything less means the queue is empty or nearly so. This is
      // what keeps latency at roughly one poll interval when idle while still
      // clearing a backlog at full speed.
      if (published === BATCH_SIZE) continue;
      if (this.running) await this.sleep(IDLE_POLL_MS);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      // One exit for both paths — the timer firing and shutdown cutting it
      // short — so the promise resolves exactly once either way.
      const finish = (): void => {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = null;
        this.wake = null;
        resolve();
      };
      this.wake = finish;
      this.idleTimer = setTimeout(finish, ms);
    });
  }

  /**
   * Claim a batch, publish it, mark it sent. Returns how many were published.
   *
   * The whole batch is claimed and released inside one transaction, and the
   * claim is what makes two API replicas cooperate rather than collide.
   */
  private async sweep(): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      // `FOR UPDATE SKIP LOCKED` is the load-bearing clause. Production runs
      // two API replicas (infra/docker-compose.prod.yml api-1/api-2), so
      // without it both would select the same rows on the same tick and
      // publish every event twice — not occasionally, but as the steady state.
      // `processed_events` would absorb the duplicates, which is why T059's
      // text calls them harmless, but "harmless" is not a reason to double the
      // broker's traffic forever. SKIP LOCKED makes each replica take rows the
      // other has not, so they share the queue instead of racing for it.
      //
      // Raw SQL rather than the query builder: `setLock('pessimistic_write')`
      // plus `skip locked` is expressible, but the resulting call reads far
      // less like the thing it does than the SQL does.
      const rows = (await manager.query(
        `SELECT event_id, routing_key, payload
           FROM outbox
          WHERE published_at IS NULL
          ORDER BY occurred_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [BATCH_SIZE],
      )) as Array<{ event_id: string; routing_key: string; payload: object }>;

      if (rows.length === 0) return 0;

      const sent: string[] = [];
      for (const row of rows) {
        try {
          // Awaited one at a time, deliberately. The publisher's promise
          // resolves on the broker's ack (T054), so this is the point where
          // "published" stops being a hope — and publishing the batch in
          // parallel would make a partial failure much harder to account for
          // than the throughput is worth at this volume.
          await this.publisher.publish(row.routing_key, row.payload);
          sent.push(row.event_id);
        } catch (err) {
          // Stop at the first failure rather than pressing on: whatever broke
          // the broker for this event will almost certainly break the next,
          // and ordering by occurred_at means the rows behind it are newer.
          // Everything already acknowledged is still marked below.
          this.logger.error(
            `outbox publish failed for ${row.event_id}; leaving it and the rest of the batch unpublished`,
            err instanceof Error ? err.stack : undefined,
          );
          break;
        }
      }

      if (sent.length > 0) {
        // Marked only after the ack, so a crash in between re-sends rather
        // than loses. See the class comment on why that direction is right.
        await manager.query(
          `UPDATE outbox SET published_at = now() WHERE event_id = ANY($1::uuid[])`,
          [sent],
        );
        this.logger.log(`published ${sent.length} outbox event(s)`);
      }

      return sent.length;
    });
  }

  /**
   * Run one sweep and report what it published.
   *
   * Exists for tests, which need a sweep they can await instead of a loop they
   * would have to wait out. Nothing in the application calls it.
   */
  async sweepOnce(): Promise<number> {
    return this.sweep();
  }
}
