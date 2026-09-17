import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { WORKOUT_UPLOADED_ROUTING_KEY } from '@workout-logging/shared';

/**
 * How long a workout may sit `pending` before the sweep assumes its event was lost.
 *
 * Derived from measured behaviour, not picked for roundness. Against the live
 * database (n=41 processed events) the time from an event being created to the
 * worker finishing it was p50 6.3s, p95 23.0s, max 23.4s. But the happy path is
 * not the bound — a workout that keeps failing retries legitimately stays
 * `pending` for far longer:
 *
 * ```
 *   retry ladder (shared/events/rabbitmq.ts)   5s + 30s + 300s = 335s
 *   four parse attempts at the p95 of 23s                      ≈  92s
 *   relay poll                                                 ≤   1s
 *                                                               ------
 *   worst legitimate pending lifetime                          ≈ 428s  (7.1 min)
 * ```
 *
 * 15 minutes is a little over twice that. The headroom is the point: re-arming
 * a workout that is merely *slow* means the parser runs again, and a second
 * parse costs an Anthropic call and writes a second set of exercises (the
 * worker's status update is guarded, but its exercise inserts are not). So the
 * threshold is deliberately far past anything a healthy system produces —
 * whatever it catches is genuinely stuck, not just late.
 */
const STUCK_AFTER_MS = 15 * 60_000;

/**
 * How old is too old to keep retrying.
 *
 * Without an upper bound this sweep would re-publish a permanently broken
 * workout every 15 minutes forever, burning an AI call each time. The worker
 * marks a workout `failed` once retries are exhausted, so anything still
 * `pending` a day later did not fail in a way the pipeline understands — it
 * needs a person, not another attempt.
 *
 * Choosing a bound rather than a re-publish counter is what keeps this
 * migration-free: the alternative is a column on `workouts` or `outbox` whose
 * only reader is this service.
 */
const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;

/** How often to look. Far below the threshold, so nothing waits a full cycle. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Re-publishes the events of workouts that got stuck `pending`.
 *
 * The net under the other two increments. T054's confirms and T055's
 * compensation close the window where a publish is lost inside a request;
 * T058's outbox closes the window between committing state and queueing its
 * event. What none of them cover is an event that was published, acknowledged,
 * and then lost downstream — a broker that dropped it, a worker that died
 * holding it, a queue that was purged. To a user, all of those look the same:
 * a workout that never leaves the in-flight surface (SC-012).
 *
 * **It re-publishes by re-arming the existing outbox row**, setting
 * `published_at` back to NULL so the relay picks it up again:
 *
 * ```
 * onModuleInit -> loop() -> sweep()
 *                             UPDATE outbox SET published_at = NULL
 *                                WHERE its workout is still pending and old
 *                           -> OutboxRelayService publishes it within ~1s
 * ```
 *
 * Two things fall out of that choice, and both matter more than they look:
 *
 * **The `event_id` stays the same**, which is what makes a duplicate harmless
 * here. `withEventIdempotency` inserts into `processed_events` in the *same
 * transaction* as the parse, so an id present there means the work committed —
 * and a committed parse leaves the workout non-pending. A workout that is still
 * pending therefore has an id that was never processed, so re-publishing it
 * will be processed; and if the original message turns out to still be in
 * flight, whichever transaction commits first wins and the other is skipped.
 * A *fresh* id would bypass that machinery entirely and parse the workout
 * twice, writing a second set of exercises. That is the bug this design avoids
 * rather than mitigates.
 *
 * **No publisher, no broker connection, no confirms here.** Delivery is
 * entirely the relay's problem, already solved once.
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
      // The first sweep waits a full interval rather than running at boot. A
      // process that crash-loops would otherwise re-arm on every restart, and
      // anything genuinely stuck has already waited fifteen minutes — one more
      // is not the difference.
      await this.sleep(SWEEP_INTERVAL_MS);
      if (!this.running) return;

      try {
        await this.sweep();
      } catch (err) {
        // Same reasoning as the relay: this loop must not die. It is the last
        // line of defence, and a silent exit would leave nothing watching.
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

  /**
   * Re-arm every stuck workout's event. Returns how many were re-armed.
   *
   * Exists as a method the tests can await; nothing else calls it directly.
   */
  async sweepOnce(): Promise<number> {
    return this.sweep();
  }

  private async sweep(): Promise<number> {
    // One statement, which is what makes two API replicas safe without a lock
    // clause. Under READ COMMITTED the second replica's UPDATE re-evaluates its
    // predicate after the first commits, sees `published_at IS NULL`, and
    // matches nothing — so a row is re-armed once, not once per replica.
    //
    // `published_at IS NOT NULL` is therefore doing two jobs: it skips rows the
    // relay has not delivered yet (those are not stuck, just queued) and it
    // makes the statement idempotent between replicas.
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
      // Logged per workout, not just counted: this fires only when something
      // has already gone wrong, and the id is what makes the incident
      // traceable afterwards (FR-029).
      for (const row of rows) {
        this.logger.warn(
          `re-publishing workout.uploaded for stuck workout ${row.workout_id} (event ${row.event_id})`,
        );
      }
    }

    return rows.length;
  }
}
