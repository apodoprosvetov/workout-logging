import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { TestingModule, Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  connectRabbitMq,
  createMongooseConnection,
  createTypeOrmDataSource,
  mongoUri,
  typeOrmDataSourceOptions,
  User,
  WorkoutSource,
  WorkoutStatus,
  WORKOUT_EVENTS_EXCHANGE,
  WORKOUT_PARSE_QUEUE,
  WORKOUT_UPLOADED_ROUTING_KEY,
} from '@workout-logging/shared';

import { OutboxReconciliationService } from '../../src/events/outbox-reconciliation.service';
import { OutboxRelayService } from '../../src/events/outbox-relay.service';
import { RabbitMqPublisherService } from '../../src/events/rabbitmq-publisher.service';
import { IngestionService } from '../../src/workouts/ingestion.service';
import { WorkoutsModule } from '../../src/workouts/workouts.module';

import type { Channel, ChannelModel } from 'amqplib';

// The relay is the only link between the API and the parser since T058, so
// these run it against real Postgres and a real broker. The loop is stopped in
// `beforeAll` and every test drives `sweepOnce()` directly: a background timer
// would make each assertion a race against a 1s poll, and "usually passes" is
// the one result a test must never give.
//
// **The broker-outage tests (T060) live in this file deliberately.** They
// started as their own spec and made this one fail roughly one run in three:
// a sweep claims whatever is unpublished, so two spec files driving relays in
// parallel against one `outbox` table publish each other's rows out from under
// their assertions. Vitest parallelises files but runs tests within a file in
// order, so sharing a file is what makes them sequential. Splitting them again
// reintroduces the flake.
describe('OutboxRelayService (integration, real Postgres + RabbitMQ)', () => {
  let moduleRef: TestingModule;
  let relay: OutboxRelayService;
  let publisher: RabbitMqPublisherService;
  let reconciliation: OutboxReconciliationService;
  let ingestion: IngestionService;
  let ds: DataSource;
  let amqpConnection: ChannelModel;
  let amqpChannel: Channel;
  /** Our own copy of the exchange's traffic, immune to the dev worker. */
  let spyQueue: string;
  /** Rows this suite created, so cleanup never touches anything else. */
  const created: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ envFilePath: path.resolve(__dirname, '../../../../.env') }),
        TypeOrmModule.forRoot(typeOrmDataSourceOptions),
        // Needed even though the relay never touches Mongo: the module graph
        // pulls in AuthModule, which registers the RawUpload schema for account
        // deletion, and forFeature needs a connection to register it on.
        MongooseModule.forRoot(mongoUri),
        // WorkoutsModule rather than EventsModule: it imports EventsModule, so
        // the relay is still here, and it also brings IngestionService, which
        // the outage tests need to prove a workout is accepted with the broker
        // down.
        WorkoutsModule,
      ],
    }).compile();
    await moduleRef.init();

    // `strict: false`: these providers live in EventsModule, one level below
    // the WorkoutsModule imported above.
    relay = moduleRef.get(OutboxRelayService, { strict: false });
    await relay.onModuleDestroy();
    publisher = moduleRef.get(RabbitMqPublisherService, { strict: false });
    // Driven by hand for the same reason as the relay: a background sweep would
    // re-arm rows between the assertions below.
    reconciliation = moduleRef.get(OutboxReconciliationService, { strict: false });
    await reconciliation.onModuleDestroy();
    ingestion = moduleRef.get(IngestionService, { strict: false });

    ds = await createTypeOrmDataSource().initialize();
    amqpConnection = await connectRabbitMq();
    amqpChannel = await amqpConnection.createChannel();

    await assertNoCompetingRelay();

    // One queue of our own, bound to the exchange, shared by every block below.
    //
    // Never `workout.parse.q`: a running dev worker drains the real queue and
    // would win the race. Exclusive + autoDelete so a failed run leaves nothing
    // accumulating on the broker.
    const declared = await amqpChannel.assertQueue('', { exclusive: true, autoDelete: true });
    spyQueue = declared.queue;
    await amqpChannel.bindQueue(spyQueue, WORKOUT_EVENTS_EXCHANGE, WORKOUT_UPLOADED_ROUTING_KEY);

    // No draining, and no assertions on how many rows a sweep returned.
    // `outbox` is global by design — the relay publishes whatever is waiting,
    // including rows another spec file wrote moments ago, and vitest runs spec
    // files in parallel. Every assertion below is therefore about *this
    // suite's own* rows, which nothing else touches. An earlier version
    // asserted sweep counts, passed alone, and failed the moment the full
    // suite ran.
  });

  afterAll(async () => {
    // Every teardown is guarded: if `beforeAll` fails partway, an unguarded
    // cleanup throws its own TypeError and that is the error vitest reports,
    // burying the real one. This suite already lost a debugging round to it.
    if (ds?.isInitialized) {
      if (created.length > 0) {
        await ds.query(`DELETE FROM outbox WHERE event_id = ANY($1::uuid[])`, [created]);
      }
      await ds.destroy();
    }
    await amqpChannel?.close();
    await amqpConnection?.close();
    await moduleRef?.close();
  });

  beforeEach(async () => {
    // A live dev worker also drains this queue, so the suite never asserts on
    // queue *contents* — only on what the relay wrote back to Postgres, which
    // nothing else touches. Purging keeps a backlog from slowing the broker.
    await amqpChannel.purgeQueue(WORKOUT_PARSE_QUEUE);
  });

  /**
   * Refuse to run if another relay is sweeping this database.
   *
   * `outbox` is shared, and every API instance sweeps it — that is the design,
   * and `SKIP LOCKED` exists precisely so replicas can. It also means a running
   * `npm run dev` API publishes rows this suite inserts, within about a second.
   * Two assertions here cannot survive that: "the row stays unpublished when
   * the broker does not ack" fails outright, and — worse — "the event reaches
   * the exchange after the broker returns" would *pass for the wrong reason*,
   * because the other relay delivered it.
   *
   * So this probes for a competitor rather than hoping: it writes one row,
   * waits longer than a poll interval, and checks whether anything published
   * it. A silent skip would hide the coverage; a clear refusal tells the reader
   * exactly what to do. CI runs no dev server, so this never fires there.
   */
  async function assertNoCompetingRelay(): Promise<void> {
    const probeId = randomUUID();
    await ds.query(
      `INSERT INTO outbox (event_id, routing_key, payload, occurred_at, published_at)
       VALUES ($1, $2, $3, now(), NULL)`,
      [probeId, WORKOUT_UPLOADED_ROUTING_KEY, JSON.stringify({ probe: 'relay-exclusivity' })],
    );
    try {
      // IDLE_POLL_MS is 1s; 2.5s is comfortably past one sweep plus its publish.
      await new Promise((r) => setTimeout(r, 2500));
      const rows = (await ds.query(`SELECT published_at FROM outbox WHERE event_id = $1`, [
        probeId,
      ])) as Array<{ published_at: Date | null }>;

      if (rows[0]?.published_at !== null) {
        throw new Error(
          'another outbox relay is publishing against this database — stop the dev API ' +
            '(npm run dev) before running these tests. They assert that specific rows stay ' +
            'unpublished, which no other relay can be allowed to contradict.',
        );
      }
    } finally {
      await ds.query(`DELETE FROM outbox WHERE event_id = $1`, [probeId]);
    }
  }

  /**
   * Reads the bound queue until an event matching `field`/`value` arrives.
   *
   * Matching on a field rather than taking the next message: the queue carries
   * every `workout.uploaded` on the exchange, including those from sibling
   * blocks and from a dev API if one is up, so "the next message" is not
   * necessarily ours.
   */
  async function waitForEvent(
    field: 'workout_id' | 'event_id',
    value: string,
    timeoutMs = 5000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = await amqpChannel.get(spyQueue, { noAck: true });
      if (msg) {
        const event = JSON.parse(msg.content.toString()) as Record<string, unknown>;
        if (event[field] === value) return true;
        continue;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  /** Writes an unpublished outbox row and returns its event id. */
  async function queueEvent(occurredAt = new Date()): Promise<string> {
    const eventId = randomUUID();
    created.push(eventId);
    await ds.query(
      `INSERT INTO outbox (event_id, routing_key, payload, occurred_at, published_at)
       VALUES ($1, $2, $3, $4, NULL)`,
      [
        eventId,
        WORKOUT_UPLOADED_ROUTING_KEY,
        JSON.stringify({ event_id: eventId, marker: 'outbox-relay-spec' }),
        occurredAt,
      ],
    );
    return eventId;
  }

  async function publishedAt(eventId: string): Promise<Date | null> {
    const rows = (await ds.query(`SELECT published_at FROM outbox WHERE event_id = $1`, [
      eventId,
    ])) as Array<{ published_at: Date | null }>;
    return rows[0]?.published_at ?? null;
  }

  it('publishes a waiting event and stamps published_at', async () => {
    const eventId = await queueEvent();

    await relay.sweepOnce();
    expect(await publishedAt(eventId)).toBeInstanceOf(Date);
  });

  it('does not publish the same event twice', async () => {
    const eventId = await queueEvent();
    await relay.sweepOnce();
    const firstStamp = await publishedAt(eventId);

    // The partial index and the WHERE clause agree on `published_at IS NULL`,
    // so a stamped row is invisible to the next sweep. If it were not, every
    // sweep would re-publish the entire history of the table.
    await relay.sweepOnce();
    expect(await publishedAt(eventId)).toEqual(firstStamp);
  });

  it('leaves the event unpublished when the broker does not acknowledge', async () => {
    const eventId = await queueEvent();
    const spy = vi
      .spyOn(publisher, 'publish')
      .mockRejectedValue(new Error('broker never acknowledged'));

    try {
      await relay.sweepOnce();
    } finally {
      spy.mockRestore();
    }

    // At-least-once, never at-most-once: an unacknowledged publish must leave
    // the row exactly as it was, so the next sweep tries again. Stamping it
    // before the ack would turn a broker hiccup into a silently lost workout.
    expect(await publishedAt(eventId)).toBeNull();

    await relay.sweepOnce();
    expect(await publishedAt(eventId)).toBeInstanceOf(Date);
  });

  it('skips rows another replica has claimed, rather than waiting for them', async () => {
    // The claim behind choosing `FOR UPDATE SKIP LOCKED`. Production runs two
    // API replicas, so without it both sweep the same rows on the same tick and
    // publish everything twice as the steady state. This stands in for the
    // other replica by holding a real row lock in a separate connection.
    const locked = await queueEvent(new Date(Date.now() - 60_000));
    const free = await queueEvent();

    const other = await createTypeOrmDataSource().initialize();
    const runner = other.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(`SELECT event_id FROM outbox WHERE event_id = $1 FOR UPDATE`, [locked]);

      // `locked` is older, so ORDER BY occurred_at puts it first. A sweep
      // without SKIP LOCKED blocks on the lock and never returns — which is
      // how the mutation check catches its removal: this line times out.
      await relay.sweepOnce();
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
      await other.destroy();
    }

    expect(await publishedAt(free)).toBeInstanceOf(Date);
    expect(await publishedAt(locked)).toBeNull();

    // Once the other replica lets go, the skipped row is picked up normally —
    // skipping defers work, it never drops it.
    await relay.sweepOnce();
    expect(await publishedAt(locked)).toBeInstanceOf(Date);
  });

  it('publishes oldest first', async () => {
    const older = await queueEvent(new Date(Date.now() - 120_000));
    const newer = await queueEvent(new Date(Date.now() - 60_000));

    const order: string[] = [];
    const spy = vi.spyOn(publisher, 'publish').mockImplementation(async (_key, payload) => {
      order.push((payload as { event_id: string }).event_id);
    });

    try {
      await relay.sweepOnce();
    } finally {
      spy.mockRestore();
    }

    // FIFO matters here beyond tidiness: a workout's events must reach the
    // parser in the order they happened, and `occurred_at` is the only thing
    // that records that order once the request that made them is gone.
    expect(order.indexOf(older)).toBeLessThan(order.indexOf(newer));
  });
  // T060: the guarantee increment 2 buys that T054/T055 could not — a broker
  // outage stops being the caller's problem. Before the outbox, POST /workouts
  // published inside the request, so an unreachable broker meant a 503 and a
  // workout the user had to log again.
  //
  // The outage is real, not mocked: the publisher's AMQP connection is
  // genuinely closed and later genuinely reopened, so `publish` fails the way
  // it fails against a dead broker. What this deliberately does *not* do is
  // `docker compose stop rabbitmq` — sibling spec files need the broker, and
  // stopping it would fail them for reasons that have nothing to do with them.
  describe('a broker outage (T060)', () => {
    let userId: string;
    let outageWorkoutId: string;

    beforeAll(async () => {
      const user = await ds
        .getRepository(User)
        .save(
          ds
            .getRepository(User)
            .create({ email: `outbox-outage-${Date.now()}@example.com`, passwordHash: 'x' }),
        );
      userId = user.id;
    });

    afterAll(async () => {
      await ds.query(`DELETE FROM outbox WHERE payload->>'user_id' = $1`, [userId]);
      await ds.query('DELETE FROM workouts WHERE user_id = $1', [userId]);
      await ds.query('DELETE FROM users WHERE id = $1', [userId]);
      const mongo = await createMongooseConnection();
      await mongo.model('RawUpload').deleteMany({ user_id: userId });
      await mongo.close();
    });

    it('accepts a workout while the broker is unreachable, and queues the event', async () => {
      // A real disconnect: any publish from here fails exactly as it would
      // against a stopped broker.
      await publisher.onModuleDestroy();

      const result = await ingestion.ingest({
        userId,
        text: 'front squat 90kg x5',
        source: WorkoutSource.WEB,
      });

      // The whole point of increment 2. Under T054/T055 this was a 503 and the
      // user had to log the workout again; the request path no longer touches
      // the broker at all, so the outage is invisible to the caller.
      expect(result.status).toBe(WorkoutStatus.PENDING);
      outageWorkoutId = result.workoutId;

      const rows = (await ds.query(`SELECT * FROM outbox WHERE payload->>'workout_id' = $1`, [
        result.workoutId,
      ])) as Array<{ published_at: Date | null; routing_key: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].routing_key).toBe(WORKOUT_UPLOADED_ROUTING_KEY);
      // Waiting, not lost: durable in Postgres with nothing to deliver it yet.
      expect(rows[0].published_at).toBeNull();

      // And the relay genuinely cannot publish it while the broker is away —
      // otherwise the next test would prove nothing about recovery.
      await relay.sweepOnce();
      const stillWaiting = (await ds.query(
        `SELECT published_at FROM outbox WHERE payload->>'workout_id' = $1`,
        [result.workoutId],
      )) as Array<{ published_at: Date | null }>;
      expect(stillWaiting[0].published_at).toBeNull();
    });

    it('publishes the queued event once the broker returns, and it reaches the exchange', async () => {
      expect(outageWorkoutId).toBeDefined();

      // Same lifecycle hook the application uses, so the reconnect path under
      // test is the real one.
      await publisher.onModuleInit();

      await relay.sweepOnce();

      const rows = (await ds.query(
        `SELECT published_at FROM outbox WHERE payload->>'workout_id' = $1`,
        [outageWorkoutId],
      )) as Array<{ published_at: Date | null }>;
      expect(rows[0].published_at).toBeInstanceOf(Date);

      // Stamped is not delivered — the row could say published while the
      // exchange routed it nowhere. Reading it back off a bound queue is what
      // makes this end-to-end rather than self-reported.
      expect(await waitForEvent('workout_id', outageWorkoutId)).toBe(true);
    });
  });
  // T062: the reconciliation sweep (T061), the net under the other two
  // increments. It lives in this file for the same reason the outage tests do —
  // it rewrites `published_at` on rows the relay tests assert on, and vitest
  // parallelises files but orders tests within one.
  describe('the reconciliation sweep (T062)', () => {
    let sweepUserId: string;

    beforeAll(async () => {
      const user = await ds
        .getRepository(User)
        .save(
          ds
            .getRepository(User)
            .create({ email: `outbox-sweep-${Date.now()}@example.com`, passwordHash: 'x' }),
        );
      sweepUserId = user.id;
    });

    afterAll(async () => {
      await ds.query(`DELETE FROM outbox WHERE payload->>'user_id' = $1`, [sweepUserId]);
      await ds.query('DELETE FROM workouts WHERE user_id = $1', [sweepUserId]);
      await ds.query('DELETE FROM users WHERE id = $1', [sweepUserId]);
    });

    /**
     * A pending workout of a given age, with its event already published.
     *
     * Written straight to SQL rather than through `IngestionService`: the point
     * is a workout that is *old*, and the service always stamps `created_at`
     * as now. Backdating the row is the only way to reach the threshold without
     * a fifteen-minute test.
     */
    async function agedWorkout(ageMs: number, status = 'pending'): Promise<string> {
      const workoutId = randomUUID();
      const eventId = randomUUID();
      await ds.query(
        `INSERT INTO workouts (id, user_id, source, has_text, has_image, raw_input_ref,
                               status, performed_at, created_at, performed_at_explicit)
         VALUES ($1,$2,'web',true,false,'x',$3::workouts_status_enum, now(),
                 now() - ($4::bigint * interval '1 millisecond'), false)`,
        [workoutId, sweepUserId, status, ageMs],
      );
      await ds.query(
        `INSERT INTO outbox (event_id, routing_key, payload, occurred_at, published_at)
         VALUES ($1,$2,$3,now(),now())`,
        [
          eventId,
          WORKOUT_UPLOADED_ROUTING_KEY,
          JSON.stringify({ event_id: eventId, user_id: sweepUserId, workout_id: workoutId }),
        ],
      );
      return workoutId;
    }

    async function isRearmed(workoutId: string): Promise<boolean> {
      const rows = (await ds.query(
        `SELECT published_at FROM outbox WHERE payload->>'workout_id' = $1`,
        [workoutId],
      )) as Array<{ published_at: Date | null }>;
      return rows[0].published_at === null;
    }

    it('re-publishes a workout stuck past the threshold', async () => {
      const stuck = await agedWorkout(20 * 60_000);

      await reconciliation.sweepOnce();

      // Re-arming the existing row rather than inserting a new event is what
      // keeps the `event_id` stable, which is what makes a duplicate harmless
      // (see the service comment). So "re-published" is observable as the row
      // going back to unpublished, ready for the relay.
      expect(await isRearmed(stuck)).toBe(true);
    });

    it('leaves a workout inside the threshold alone', async () => {
      // Two minutes old: well inside the worst legitimate pending lifetime of
      // ~7 minutes (retry ladder plus four parse attempts). Re-publishing this
      // one would parse a workout that is merely slow, and the parser has no
      // early return for an already-settled workout — a second parse writes a
      // second set of exercises.
      const fresh = await agedWorkout(2 * 60_000);

      await reconciliation.sweepOnce();

      expect(await isRearmed(fresh)).toBe(false);
    });

    it('gives up on a workout older than a day', async () => {
      // The upper bound. Without it this sweep would re-publish a permanently
      // broken workout every fifteen minutes forever, burning an AI call each
      // time. Anything still pending a day later needs a person.
      const ancient = await agedWorkout(30 * 60 * 60_000);

      await reconciliation.sweepOnce();

      expect(await isRearmed(ancient)).toBe(false);
    });

    it('ignores a workout that already reached a terminal status', async () => {
      const settled = await agedWorkout(20 * 60_000, 'parsed');

      await reconciliation.sweepOnce();

      expect(await isRearmed(settled)).toBe(false);
    });

    it('re-publishes once per sweep, not once per replica', async () => {
      const stuck = await agedWorkout(20 * 60_000);
      await reconciliation.sweepOnce();
      expect(await isRearmed(stuck)).toBe(true);

      // Scoped to this row rather than to the sweep's return count: `outbox` is
      // shared and the sweep legitimately sees every stuck workout in the
      // database. What must hold is that an already-re-armed row is not
      // selected again — which is what makes two API replicas safe with no lock
      // clause, since the second UPDATE re-evaluates `published_at IS NOT NULL`
      // after the first commits and matches nothing.
      const before = (await ds.query(
        `SELECT published_at, occurred_at FROM outbox WHERE payload->>'workout_id' = $1`,
        [stuck],
      )) as unknown[];
      await reconciliation.sweepOnce();
      const after = (await ds.query(
        `SELECT published_at, occurred_at FROM outbox WHERE payload->>'workout_id' = $1`,
        [stuck],
      )) as unknown[];
      expect(after).toEqual(before);
    });

    it('hands the re-armed event to the relay, which delivers it', async () => {
      const stuck = await agedWorkout(20 * 60_000);
      const [row] = (await ds.query(
        `SELECT event_id FROM outbox WHERE payload->>'workout_id' = $1`,
        [stuck],
      )) as Array<{ event_id: string }>;

      await reconciliation.sweepOnce();
      await relay.sweepOnce();

      // The two halves joined up: the sweep only re-arms, and the relay is what
      // puts the event back on the exchange. Reading it off a bound queue is
      // what makes that end-to-end rather than two services each reporting
      // success to themselves.
      //
      // **Not asserted here: the workout reaching a terminal status.** That is
      // the worker's half — it needs a live parser and an Anthropic call, so it
      // belongs to quickstart scenario 1 (T049), not to a suite that must be
      // deterministic.
      expect(await isRearmed(stuck)).toBe(false);
      expect(await waitForEvent('event_id', row.event_id)).toBe(true);
    });
  });
});
