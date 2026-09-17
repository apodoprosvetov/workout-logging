import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Events waiting to be published to RabbitMQ.
 *
 * The point of the table is that a row lands here in the **same Postgres
 * transaction** as the state it describes (T058), so "the workout exists" and
 * "the event exists" become one atomic fact. A relay (T059) publishes the rows
 * afterwards and stamps `publishedAt`. That is what turns Constitution
 * Principle IV — "an event that drives work MUST be published only after the
 * state it describes has committed" — from something observed into something
 * structurally impossible to violate.
 *
 * Note what it does *not* cover: an outbox spans one database. The ingest path
 * also writes GridFS and `raw_uploads` in MongoDB, and nothing here helps if
 * the Postgres transaction fails after those — that stays T055's compensating
 * action.
 */
// The relay's only query: unpublished rows, oldest first. Partial, because
// published rows are permanent and unpublished ones are a handful at any
// moment — a full index would grow with the table forever while the relay only
// ever reads its newest sliver. The predicate is repeated verbatim in the
// relay's WHERE clause; Postgres only uses a partial index when it can prove
// the query implies the predicate, so those two must stay in step.
@Index(['occurredAt'], { where: '"published_at" IS NULL' })
@Entity('outbox')
export class OutboxEvent {
  /**
   * The event's own id, not a surrogate key.
   *
   * Same choice as `processed_events` and for a related reason: the id is
   * supplied by the code that built the event, never generated here. Making it
   * the primary key means a retry that re-inserts the same event conflicts
   * instead of queueing a duplicate — free idempotency on the write side, to
   * match the `withEventIdempotency` the consumers already have on the read
   * side.
   */
  @PrimaryColumn('uuid')
  eventId!: string;

  /** The exchange routing key, e.g. `workout.uploaded`. */
  @Column({ type: 'text' })
  routingKey!: string;

  /**
   * The full event envelope, published verbatim to the exchange.
   *
   * `jsonb` rather than `text`: this is a table people will read in psql when a
   * workout is stuck, and `text` makes that grep-and-squint. The cost is that
   * Postgres normalises the document — key order is not preserved and
   * duplicate keys collapse — which is fine here because every consumer parses
   * it as JSON and none of them depend on byte-for-byte identity. If one ever
   * did (a signature over the raw body, say), this would have to become `text`.
   */
  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  /**
   * When the event happened, as the envelope reports it.
   *
   * Deliberately not `@CreateDateColumn`: the row is written in the same breath
   * as the event is built, but this must be the event's own timestamp, because
   * that is what consumers see. A separate insert time would be a second
   * version of the truth with no reader.
   */
  @Column({ type: 'timestamptz' })
  occurredAt!: Date;

  /**
   * When the relay got an acknowledgement from the broker, or null while the
   * event is still waiting.
   *
   * Null is the queue: there is no status column, because a nullable timestamp
   * already answers both "is it sent" and "when", and two fields that can
   * disagree about the same thing is one field too many. Rows are kept after
   * publishing rather than deleted — they are the record of what was actually
   * sent, which is the first thing anyone wants when a consumer misbehaves.
   * Nothing prunes them yet; when the table gets big enough to care, deleting
   * by `publishedAt` is the obvious sweep.
   */
  @Column({ type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;
}
