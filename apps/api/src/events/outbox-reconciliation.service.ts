import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { WORKOUT_UPLOADED_ROUTING_KEY } from '@workout-logging/shared';

/**
 * How long a workout may sit `pending` before its event is assumed lost.
 *
 * Measured, not rounded. Parse latency against the live database (n=41) was p50
 * 6.3s / p95 23.0s, but the bound is a workout failing retries: the ladder
 * (5s + 30s + 300s) plus four attempts at the p95 ≈ **428s**.
 *
 * 15 min is twice that, and the headroom is the point: re-arming a merely slow
 * workout parses it again, costing an AI call and a **second set of exercises**
 * — the worker's status update is guarded, its exercise inserts are not.
 */
const STUCK_AFTER_MS = 15 * 60_000;

/**
 * Upper bound, or a permanently broken workout is re-published every 15 minutes
 * forever. The worker marks exhausted retries `failed`, so anything still
 * `pending` a day later needs a person. A bound rather than a re-publish
 * counter keeps this migration-free.
 */
const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;

/** How often to look. Far below the threshold, so nothing waits a full cycle. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Re-publishes the events of workouts stuck `pending` — the net under the other
 * two increments.
 *
 * Confirms and compensation close the window where a publish is lost inside a
 * request; the outbox closes the one between committing state and queueing its
 * event. Neither covers an event published, acked, then lost downstream. To a
 * user all three look the same: a workout that never leaves the in-flight
 * surface (SC-012).
 *
 * ```
 * onModuleInit -> loop() -> sweep()
 *                             UPDATE outbox SET published_at = NULL
 *                                WHERE its workout is still pending and old
 *                           -> OutboxRelayService publishes it within ~1s
 * ```
 *
 * **Re-arming the existing row keeps the `event_id`, and that is what makes a
 * duplicate harmless.** `withEventIdempotency` inserts into `processed_events`
 * in the same transaction as the parse, so an id present there means the parse
 * committed — and a committed parse leaves the workout non-pending. A still-
 * pending workout's id was therefore never processed; and if the original
 * message is still in flight, the first transaction to commit wins. A fresh id
 * would bypass all of that and parse the workout twice.
 *
 * No publisher and no broker connection here — delivery is the relay's job.
 */
@Injectable()
export class OutboxReconciliationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxReconciliationService.name);
  private running = false;
  private loop: Promise<void> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private wake: (() => void) | null = null;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  onModuleInit(): void {
    this.running = true;
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      // Waits before the first sweep: a crash-looping process would otherwise
      // re-arm on every restart, and anything stuck has already waited 15 min.
      await this.sleep(SWEEP_INTERVAL_MS);
      if (!this.running) return;

      try {
        await this.sweep();
      } catch (err) {
        // Must not die: this is the last line of defence.
        this.logger.error(
          'reconciliation sweep failed; retrying',
          err instanceof Error ? err.stack : undefined,
        );
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
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

  /** A sweep the tests can await; nothing else calls it. */
  async sweepOnce(): Promise<number> {
    return this.sweep();
  }

  private async sweep(): Promise<number> {
    // One statement, which is what makes two replicas safe with no lock clause:
    // under READ COMMITTED the second UPDATE re-evaluates after the first
    // commits, sees `published_at IS NULL` and matches nothing.
    //
    // So `published_at IS NOT NULL` does two jobs — skip rows the relay simply
    // has not reached yet, and make this idempotent between replicas.
    const rows = (await this.dataSource.query(
      `UPDATE outbox
          SET published_at = NULL
        WHERE event_id IN (
          SELECT o.event_id
            FROM outbox o
            JOIN workouts w ON w.id = (o.payload->>'workout_id')::uuid
           WHERE o.routing_key = $1
             AND o.published_at IS NOT NULL
             AND w.status = 'pending'
             AND w.created_at < now() - ($2::bigint * interval '1 millisecond')
             AND w.created_at > now() - ($3::bigint * interval '1 millisecond')
        )
        RETURNING event_id, payload->>'workout_id' AS workout_id`,
      [WORKOUT_UPLOADED_ROUTING_KEY, STUCK_AFTER_MS, GIVE_UP_AFTER_MS],
    )) as Array<{ event_id: string; workout_id: string }>;

    if (rows.length > 0) {
      // Per workout, not just counted: this fires only when something already
      // went wrong, and the id is what makes it traceable (FR-029).
      for (const row of rows) {
        this.logger.warn(
          `re-publishing workout.uploaded for stuck workout ${row.workout_id} (event ${row.event_id})`,
        );
      }
    }

    return rows.length;
  }
}
