import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Events waiting to be published to RabbitMQ.
 *
 * A row lands here in the same transaction as the state it describes, so the
 * two commit together — Principle IV made structural rather than observed. It
 * spans one database only: the ingest path's Mongo writes stay T055's problem.
 */
// Partial index: the relay reads only unpublished rows, and those are a handful
// while published ones accumulate forever. The predicate is repeated verbatim in
// the relay's WHERE — Postgres uses a partial index only if the query implies it.
@Index(['occurredAt'], { where: '"published_at" IS NULL' })
@Entity('outbox')
export class OutboxEvent {
  /**
   * The event's own id, not a surrogate. As primary key it makes a retry that
   * re-inserts the same event conflict rather than queue a duplicate — the
   * write-side match for consumers' `withEventIdempotency`.
   */
  @PrimaryColumn('uuid')
  eventId!: string;

  /** The exchange routing key, e.g. `workout.uploaded`. */
  @Column({ type: 'text' })
  routingKey!: string;

  /**
   * The event envelope, published verbatim.
   *
   * `jsonb` so it is readable in psql when a workout is stuck. Postgres
   * normalises key order — fine while no consumer needs byte-for-byte identity.
   *
   * `object`, not `Record<string, unknown>`: TypeORM's `insert()` rejects the
   * latter (`QueryDeepPartialEntity` recurses into its `unknown` values), and
   * the index access it advertises is a guess nobody makes.
   */
  @Column({ type: 'jsonb' })
  payload!: object;

  /**
   * The envelope's own timestamp, not `@CreateDateColumn` — consumers see this
   * one, and an insert time would be a second truth with no reader.
   */
  @Column({ type: 'timestamptz' })
  occurredAt!: Date;

  /**
   * Set on the broker's ack. **Null is the queue** — no status column, since a
   * nullable timestamp answers both "sent?" and "when". Published rows are kept
   * as the record of what was sent; nothing prunes them yet.
   */
  @Column({ type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;
}
