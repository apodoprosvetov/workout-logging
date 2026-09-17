import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { RabbitMqPublisherService } from './rabbitmq-publisher.service';

/** How long to wait between sweeps when the last one found nothing. */
const IDLE_POLL_MS = 1000;

/**
 * The batch is held under a row lock while it publishes, so this is really "how
 * long may one replica hold a slice of the queue".
 */
const BATCH_SIZE = 50;

/**
 * Publishes committed outbox events to RabbitMQ — the second half of the
 * transactional outbox. Nothing in the request path publishes any more, so
 * **if this is not running, no workout is ever parsed.**
 *
 * ```
 * onModuleInit -> loop() -> sweep() --(rows)--> publish + mark -> sweep() again
 *                             `--(none)--> wait IDLE_POLL_MS -> sweep()
 * onModuleDestroy -> stop the loop, let the sweep in flight finish
 * ```
 *
 * **At-least-once, never at-most-once.** A row is marked only after the broker
 * acks, so a crash in between re-sends rather than loses — safe because
 * consumers already dedupe via `withEventIdempotency`.
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
    // `wake()`, not `clearTimeout`: the callback is what resolves the sleep, so
    // cancelling it alone leaves the promise pending and shutdown hangs.
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let published = 0;
      try {
        published = await this.sweep();
      } catch (err) {
        // Never let the loop die: exiting here stops the whole pipeline with
        // the API still reporting healthy.
        this.logger.error(
          'outbox sweep failed; retrying',
          err instanceof Error ? err.stack : undefined,
        );
      }

      // A full batch means more is probably waiting — drain without pausing.
      // Anything less means idle, so hold latency at one poll interval.
      if (published === BATCH_SIZE) continue;
      if (this.running) await this.sleep(IDLE_POLL_MS);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      // One exit for both paths, so the promise resolves exactly once.
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

  /** Claim a batch, publish it, mark it sent — all in one transaction. */
  private async sweep(): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      // `SKIP LOCKED` is load-bearing: production runs two API replicas, and
      // without it both select the same rows on the same tick and publish every
      // event twice as the steady state. `processed_events` would absorb that,
      // but absorbing is not a reason to double broker traffic forever.
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
          // One at a time: the promise resolves on the broker's ack, and a
          // parallel batch makes a partial failure far harder to account for.
          await this.publisher.publish(row.routing_key, row.payload);
          sent.push(row.event_id);
        } catch (err) {
          // Stop at the first failure: whatever broke the broker will break the
          // next too, and the rows behind are newer. Acked ones still get marked.
          this.logger.error(
            `outbox publish failed for ${row.event_id}; leaving it and the rest of the batch unpublished`,
            err instanceof Error ? err.stack : undefined,
          );
          break;
        }
      }

      if (sent.length > 0) {
        // After the ack, so a crash in between re-sends rather than loses.
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
