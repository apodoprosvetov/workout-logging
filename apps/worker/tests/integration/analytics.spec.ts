import 'reflect-metadata';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ANALYTICS_UPDATED_KEY,
  connectRabbitMq,
  createMongooseConnection,
  createRedisClient,
  createRedisSubscriber,
  createTypeOrmDataSource,
  getEventsChannelName,
  isoWeekKey,
  seedExerciseCatalog,
  setupRabbitMqTopology,
  weeklyVolumeRedisKey,
  Exercise,
  SetUnit,
  User,
  Workout,
  WorkoutExercise,
  WorkoutSet,
  WorkoutSource,
  WorkoutStatus,
  WORKOUT_ANALYTICS_QUEUE,
  WORKOUT_DELETED_ROUTING_KEY,
  WORKOUT_EVENTS_EXCHANGE,
  WORKOUT_PARSED_ROUTING_KEY,
  WORKOUT_UPDATED_ROUTING_KEY,
} from '@workout-logging/shared';

import { registerAnalyticsConsumer } from '../../src/analytics/handler.js';

import type { WorkerContext } from '../../src/index.js';
import type { AnalyticsUpdatedNotification } from '@workout-logging/shared';
import type { Channel, ChannelModel } from 'amqplib';
import type { Redis } from 'ioredis';
import type { Connection as MongooseConnection } from 'mongoose';
import type { DataSource } from 'typeorm';

// 'bench-press' -> 'Bench Press' (the canonical exercise_catalog display name).
function slugToName(slug: string): string {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// No AI here — just Postgres + Mongo + RabbitMQ + Redis, so this runs in CI.
describe('analytics worker (integration: Postgres + MongoDB + RabbitMQ + Redis)', () => {
  let dataSource: DataSource;
  let mongoConnection: MongooseConnection;
  let amqpConnection: ChannelModel;
  let channel: Channel;
  let redis: Redis;
  let context: WorkerContext;
  let userId: string;
  const week = isoWeekKey(new Date('2026-05-04T00:00:00.000Z')); // Mon of 2026-W19

  beforeAll(async () => {
    await seedExerciseCatalog();
    dataSource = createTypeOrmDataSource();
    await dataSource.initialize();
    mongoConnection = await createMongooseConnection();
    amqpConnection = await connectRabbitMq();
    channel = await amqpConnection.createChannel();
    await setupRabbitMqTopology(channel);
    await channel.purgeQueue(WORKOUT_ANALYTICS_QUEUE);
    redis = createRedisClient();

    context = { dataSource, mongoConnection, channel, redis };
    registerAnalyticsConsumer(context);

    const user = await dataSource
      .getRepository(User)
      .save(
        dataSource
          .getRepository(User)
          .create({ email: `analytics-${Date.now()}@example.com`, passwordHash: 'x' }),
      );
    userId = user.id;
  });

  afterAll(async () => {
    await dataSource.query(
      `DELETE FROM sets WHERE workout_exercise_id IN
         (SELECT id FROM workout_exercises WHERE workout_id IN (SELECT id FROM workouts WHERE user_id = $1))`,
      [userId],
    );
    await dataSource.query(
      'DELETE FROM workout_exercises WHERE workout_id IN (SELECT id FROM workouts WHERE user_id = $1)',
      [userId],
    );
    await dataSource.query('DELETE FROM workouts WHERE user_id = $1', [userId]);
    await dataSource.query('DELETE FROM users WHERE id = $1', [userId]);
    await dataSource.destroy();
    await mongoConnection.close();
    await redis.del(weeklyVolumeRedisKey(userId, week));
    redis.disconnect();
    await channel.purgeQueue(WORKOUT_ANALYTICS_QUEUE);
    await channel.close();
    await amqpConnection.close();
  });

  interface SeedExercise {
    slug: string;
    sets: Array<{ weight: number; reps: number }>;
  }

  async function seedParsedWorkout(
    performedAt: string,
    exercises: SeedExercise[],
  ): Promise<string> {
    const workout = await dataSource.getRepository(Workout).save(
      dataSource.getRepository(Workout).create({
        userId,
        source: WorkoutSource.WEB,
        hasText: true,
        hasImage: false,
        rawInputRef: 'analytics-test',
        status: WorkoutStatus.PARSED,
        performedAt: new Date(performedAt),
        performedAtExplicit: true,
      }),
    );
    let order = 0;
    for (const ex of exercises) {
      order += 1;
      const exerciseRepo = dataSource.getRepository(Exercise);
      // Canonical display name (not the bare slug) — the `exercises` table is
      // shared with the apps/api contract specs and never cleaned up, and one
      // of them asserts on `name` (workouts.get.spec.ts).
      const exercise =
        (await exerciseRepo.findOneBy({ slug: ex.slug })) ??
        (await exerciseRepo.save(
          exerciseRepo.create({ slug: ex.slug, name: slugToName(ex.slug) }),
        ));
      const we = await dataSource.getRepository(WorkoutExercise).save(
        dataSource.getRepository(WorkoutExercise).create({
          workoutId: workout.id,
          exerciseId: exercise.id,
          exerciseOrder: order,
        }),
      );
      let setOrder = 0;
      for (const s of ex.sets) {
        setOrder += 1;
        await dataSource.getRepository(WorkoutSet).save(
          dataSource.getRepository(WorkoutSet).create({
            workoutExerciseId: we.id,
            setOrder,
            weight: String(s.weight),
            reps: s.reps,
            unit: SetUnit.KG,
          }),
        );
      }
    }
    return workout.id;
  }

  function publishParsed(workoutId: string): void {
    channel.publish(
      WORKOUT_EVENTS_EXCHANGE,
      WORKOUT_PARSED_ROUTING_KEY,
      Buffer.from(
        JSON.stringify({
          event_id: randomUUID(),
          user_id: userId,
          workout_id: workoutId,
          exercise_count: 1,
          occurred_at: new Date().toISOString(),
        }),
      ),
      { persistent: true },
    );
  }

  function publishUpdated(
    workoutId: string,
    previousPerformedAt: string,
    performedAt: string,
    routingKey: string = WORKOUT_UPDATED_ROUTING_KEY,
  ): void {
    channel.publish(
      WORKOUT_EVENTS_EXCHANGE,
      routingKey,
      Buffer.from(
        JSON.stringify({
          type: 'workout.updated',
          event_id: randomUUID(),
          user_id: userId,
          workout_id: workoutId,
          previous_performed_at: previousPerformedAt,
          performed_at: performedAt,
          occurred_at: new Date().toISOString(),
        }),
      ),
      { persistent: true },
    );
  }

  // `routingKey` is a parameter because the whole point of the discriminator is
  // that it must work regardless of it — see the WORKOUT_PARSED_ROUTING_KEY case
  // in the retry test below.
  function publishDeleted(
    workoutId: string,
    performedAt: string,
    routingKey: string = WORKOUT_DELETED_ROUTING_KEY,
  ): void {
    channel.publish(
      WORKOUT_EVENTS_EXCHANGE,
      routingKey,
      Buffer.from(
        JSON.stringify({
          type: 'workout.deleted',
          event_id: randomUUID(),
          user_id: userId,
          workout_id: workoutId,
          performed_at: performedAt,
          occurred_at: new Date().toISOString(),
        }),
      ),
      { persistent: true },
    );
  }

  async function waitForHash(timeoutMs = 8000): Promise<Record<string, string>> {
    const key = weeklyVolumeRedisKey(userId, week);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hash = await redis.hgetall(key);
      if (Object.keys(hash).length > 0) return hash;
      await new Promise((r) => setTimeout(r, 200));
    }
    return redis.hgetall(key);
  }

  it('aggregates the ISO week into weekly_volume:{user}:{week}, full set volume per muscle group', async () => {
    // bench-press -> chest/triceps/shoulders ; squat -> quads/glutes/hamstrings/core
    const id = await seedParsedWorkout('2026-05-05T00:00:00.000Z', [
      {
        slug: 'bench-press',
        sets: [
          { weight: 100, reps: 5 },
          { weight: 100, reps: 5 },
        ],
      }, // 1000
      { slug: 'squat', sets: [{ weight: 120, reps: 5 }] }, // 600
    ]);
    publishParsed(id);

    const hash = await waitForHash();
    expect(Number(hash.chest)).toBe(1000);
    expect(Number(hash.triceps)).toBe(1000);
    expect(Number(hash.shoulders)).toBe(1000);
    expect(Number(hash.quads)).toBe(600);
    expect(Number(hash.glutes)).toBe(600);
    expect(Number(hash.core)).toBe(600);
  }, 15000);

  it('is a full recompute: a workout deleted from the week drops out on the next event', async () => {
    const keep = await seedParsedWorkout('2026-05-06T00:00:00.000Z', [
      { slug: 'barbell-curl', sets: [{ weight: 30, reps: 10 }] }, // biceps 300
    ]);
    const remove = await seedParsedWorkout('2026-05-07T00:00:00.000Z', [
      { slug: 'barbell-curl', sets: [{ weight: 40, reps: 10 }] }, // biceps 400
    ]);
    publishParsed(remove);
    await new Promise((r) => setTimeout(r, 800));
    expect(
      Number((await redis.hgetall(weeklyVolumeRedisKey(userId, week))).biceps),
    ).toBeGreaterThanOrEqual(700);

    await dataSource.query(
      'DELETE FROM sets WHERE workout_exercise_id IN (SELECT id FROM workout_exercises WHERE workout_id = $1)',
      [remove],
    );
    await dataSource.query('DELETE FROM workout_exercises WHERE workout_id = $1', [remove]);
    await dataSource.query('DELETE FROM workouts WHERE id = $1', [remove]);

    publishParsed(keep);
    await new Promise((r) => setTimeout(r, 800));
    // Only `keep`'s 300 remains for these two workouts' curls (plus test 1's, which
    // didn't touch biceps). Assert the removed 400 is gone.
    expect(Number((await redis.hgetall(weeklyVolumeRedisKey(userId, week))).biceps)).toBeLessThan(
      700,
    );
  }, 15000);

  it('ignores sets whose exercise has no catalog entry', async () => {
    const id = await seedParsedWorkout('2026-05-08T00:00:00.000Z', [
      { slug: 'not-a-real-exercise-xyz', sets: [{ weight: 999, reps: 999 }] },
      { slug: 'standing-calf-raise', sets: [{ weight: 50, reps: 20 }] }, // calves 1000
    ]);
    publishParsed(id);
    await new Promise((r) => setTimeout(r, 800));
    const hash = await redis.hgetall(weeklyVolumeRedisKey(userId, week));
    expect(Number(hash.calves)).toBe(1000);
    // 999*999 never lands anywhere
    expect(Object.values(hash).every((v) => Number(v) < 998001)).toBe(true);
  }, 15000);

  it('recomputes the week from a workout.deleted event, whose workout no longer exists', async () => {
    const performedAt = '2026-05-09T00:00:00.000Z';
    const id = await seedParsedWorkout(performedAt, [
      { slug: 'lateral-raise', sets: [{ weight: 10, reps: 12 }] }, // shoulders +120
    ]);
    publishParsed(id);
    await new Promise((r) => setTimeout(r, 800));
    const before = Number((await redis.hgetall(weeklyVolumeRedisKey(userId, week))).shoulders);

    // Delete it the way apps/api does, then announce it. The consumer has to work
    // entirely from the payload — there is no row left to look the week up from.
    await dataSource.query(
      'DELETE FROM sets WHERE workout_exercise_id IN (SELECT id FROM workout_exercises WHERE workout_id = $1)',
      [id],
    );
    await dataSource.query('DELETE FROM workout_exercises WHERE workout_id = $1', [id]);
    await dataSource.query('DELETE FROM workouts WHERE id = $1', [id]);

    publishDeleted(id, performedAt);
    await new Promise((r) => setTimeout(r, 900));

    const after = Number((await redis.hgetall(weeklyVolumeRedisKey(userId, week))).shoulders);
    expect(after).toBe(before - 120);
  }, 15000);

  it('still handles a deletion that arrives under the workout.parsed routing key (post-retry)', async () => {
    // The regression this guards: workout.analytics.q's retry tiers are named per
    // primary queue and dead-letter with `x-dead-letter-routing-key:
    // workout.parsed`, so a deletion that fails once comes back to this queue
    // claiming to be a parse. Verified against the live broker.
    //
    // If the handler discriminated on msg.fields.routingKey it would take the
    // parsed branch, look the workout up, find nothing (it is deleted) and ack —
    // leaving the cache stale forever, with no error logged. The discriminator
    // lives in the body precisely so this case still recomputes.
    const performedAt = '2026-05-10T00:00:00.000Z';
    const id = await seedParsedWorkout(performedAt, [
      { slug: 'lateral-raise', sets: [{ weight: 20, reps: 10 }] }, // shoulders +200
    ]);
    publishParsed(id);
    await new Promise((r) => setTimeout(r, 800));
    const before = Number((await redis.hgetall(weeklyVolumeRedisKey(userId, week))).shoulders);

    await dataSource.query(
      'DELETE FROM sets WHERE workout_exercise_id IN (SELECT id FROM workout_exercises WHERE workout_id = $1)',
      [id],
    );
    await dataSource.query('DELETE FROM workout_exercises WHERE workout_id = $1', [id]);
    await dataSource.query('DELETE FROM workouts WHERE id = $1', [id]);

    // The deletion, wearing the routing key a retry hop would have given it.
    publishDeleted(id, performedAt, WORKOUT_PARSED_ROUTING_KEY);
    await new Promise((r) => setTimeout(r, 900));

    const after = Number((await redis.hgetall(weeklyVolumeRedisKey(userId, week))).shoulders);
    expect(after).toBe(before - 200);
  }, 15000);

  // The binding, asserted against the broker rather than by reading the queue:
  // the dev worker consumes from it too, so a `channel.get` here would be a race
  // it usually loses. A missing binding is confirmed and dropped by the exchange
  // (publish sets no `mandatory`), so nothing else would ever report it.
  it('has workout.updated bound to workout.analytics.q', async () => {
    const url = new URL(process.env.RABBITMQ_URL as string);
    const api = `http://${url.hostname}:15672/api/queues/%2F/${WORKOUT_ANALYTICS_QUEUE}/bindings`;
    const auth = Buffer.from(
      `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
    ).toString('base64');

    const res = await fetch(api, { headers: { authorization: `Basic ${auth}` } });
    expect(res.ok).toBe(true);
    const bindings = (await res.json()) as Array<{ source: string; routing_key: string }>;

    expect(
      bindings.some(
        (b) =>
          b.source === WORKOUT_EVENTS_EXCHANGE && b.routing_key === WORKOUT_UPDATED_ROUTING_KEY,
      ),
    ).toBe(true);
  });

  it('recomputes both weeks when an edit moves the workout across a week boundary', async () => {
    const from = '2026-05-06T00:00:00.000Z'; // 2026-W19
    const to = '2026-05-13T00:00:00.000Z'; // 2026-W20
    const toWeek = isoWeekKey(new Date(to));
    const id = await seedParsedWorkout(from, [
      { slug: 'barbell-curl', sets: [{ weight: 30, reps: 10 }] }, // biceps +300
    ]);
    publishParsed(id);
    await new Promise((r) => setTimeout(r, 800));

    const fromBefore = Number((await redis.hgetall(weeklyVolumeRedisKey(userId, week))).biceps);
    expect(fromBefore).toBeGreaterThanOrEqual(300);

    await dataSource.query('UPDATE workouts SET performed_at = $1 WHERE id = $2', [to, id]);
    publishUpdated(id, from, to);
    await new Promise((r) => setTimeout(r, 1200));

    const fromAfter = Number((await redis.hgetall(weeklyVolumeRedisKey(userId, week))).biceps || 0);
    const toAfter = Number((await redis.hgetall(weeklyVolumeRedisKey(userId, toWeek))).biceps || 0);

    expect(fromAfter).toBe(fromBefore - 300); // the week it left
    expect(toAfter).toBe(300); // the week it joined

    await redis.del(weeklyVolumeRedisKey(userId, toWeek));
  }, 20000);

  it('recomputes the one week when an edit stays inside it', async () => {
    const at = '2026-05-07T00:00:00.000Z'; // 2026-W19
    const id = await seedParsedWorkout(at, [
      { slug: 'standing-calf-raise', sets: [{ weight: 50, reps: 10 }] }, // calves +500
    ]);
    publishParsed(id);
    await new Promise((r) => setTimeout(r, 800));
    const before = Number((await redis.hgetall(weeklyVolumeRedisKey(userId, week))).calves);

    // Same week, heavier: 50x10 -> 60x10, so +100 on the week.
    await dataSource.query(
      `UPDATE sets SET weight = 60 WHERE workout_exercise_id IN
         (SELECT id FROM workout_exercises WHERE workout_id = $1)`,
      [id],
    );
    publishUpdated(id, at, at);
    await new Promise((r) => setTimeout(r, 1000));

    expect(Number((await redis.hgetall(weeklyVolumeRedisKey(userId, week))).calves)).toBe(
      before + 100,
    );
  }, 20000);

  it('is idempotent: the same update delivered twice leaves the same figures', async () => {
    const at = '2026-05-08T00:00:00.000Z'; // 2026-W19
    const id = await seedParsedWorkout(at, [
      { slug: 'lateral-raise', sets: [{ weight: 10, reps: 10 }] }, // shoulders +100
    ]);
    publishParsed(id);
    await new Promise((r) => setTimeout(r, 800));

    publishUpdated(id, at, at);
    await new Promise((r) => setTimeout(r, 900));
    const once = await redis.hgetall(weeklyVolumeRedisKey(userId, week));

    publishUpdated(id, at, at);
    await new Promise((r) => setTimeout(r, 900));
    const twice = await redis.hgetall(weeklyVolumeRedisKey(userId, week));

    expect(twice).toEqual(once);
  }, 20000);

  it('still handles an update that arrives under the workout.parsed routing key (post-retry)', async () => {
    // Same regression as the deletion case above: a retry hop rewrites the
    // routing key to workout.parsed. Down the parsed branch this would recompute
    // only the week the row now reports, leaving the week it left overstated.
    const previousPerformedAt = '2026-05-05T00:00:00.000Z'; // Tue of 2026-W19, the week under test
    const movedTo = '2026-06-16T00:00:00.000Z'; // a different ISO week
    const id = await seedParsedWorkout(previousPerformedAt, [
      { slug: 'lateral-raise', sets: [{ weight: 20, reps: 10 }] }, // shoulders +200
    ]);
    publishParsed(id);
    await new Promise((r) => setTimeout(r, 800));
    const before = Number((await redis.hgetall(weeklyVolumeRedisKey(userId, week))).shoulders);

    // Move it out of the week, exactly as replaceById's transaction would.
    await dataSource.query('UPDATE workouts SET performed_at = $1 WHERE id = $2', [movedTo, id]);

    publishUpdated(id, previousPerformedAt, movedTo, WORKOUT_PARSED_ROUTING_KEY);
    await new Promise((r) => setTimeout(r, 900));

    const after = Number((await redis.hgetall(weeklyVolumeRedisKey(userId, week))).shoulders);
    expect(after).toBe(before - 200);
  }, 15000);

  // T036. Not "both happened" — the order, which is the whole requirement: a
  // notification is an invitation to refetch, so announcing a recomputation
  // that has not committed races every listening client into reading the
  // figures the pipeline was about to replace.
  //
  // Asserted with MONITOR rather than by reading the hash when the notification
  // arrives. That reading proves nothing: time passes between the message
  // landing and the read, so a write that happened *after* the publish would
  // still be visible by then, and the test would pass on the broken order.
  // MONITOR reports the commands the server actually executed, in the order it
  // executed them, so the comparison is on the real sequence.
  describe('T036: analytics.updated is published after the hash is written', () => {
    const channelName = () => getEventsChannelName(userId);
    const volumeKey = () => weeklyVolumeRedisKey(userId, week);

    /**
     * Runs `trigger`, waits for the notification, and returns the server-side
     * order of the two commands that matter.
     *
     * MONITOR sees every client's traffic on this Redis, so both filters are on
     * *this* user's key and channel — a dev worker or another suite running
     * against the same instance would otherwise show up in the log.
     */
    async function orderOf(trigger: () => void): Promise<{
      hsetIndex: number;
      publishIndex: number;
      notification: AnalyticsUpdatedNotification | null;
    }> {
      const monitorClient = createRedisClient();
      const monitor = await monitorClient.monitor();
      const commands: string[][] = [];
      monitor.on('monitor', (_time: string, args: string[]) => commands.push(args));

      const subscriber = createRedisSubscriber();
      let notification: AnalyticsUpdatedNotification | null = null;
      const delivered = new Promise<void>((resolve) => {
        subscriber.on('message', (_channel: string, payload: string) => {
          const parsed = JSON.parse(payload) as AnalyticsUpdatedNotification;
          if (parsed.type === ANALYTICS_UPDATED_KEY) {
            notification = parsed;
            resolve();
          }
        });
      });
      await subscriber.subscribe(channelName());

      try {
        trigger();
        await Promise.race([delivered, new Promise((r) => setTimeout(r, 10_000))]);
        // The monitor stream is asynchronous; give the last commands a moment to
        // arrive before reading the log.
        await new Promise((r) => setTimeout(r, 300));

        const isOurs = (args: string[], name: string, target: string) =>
          args[0]?.toLowerCase() === name && args[1] === target;

        return {
          hsetIndex: commands.findIndex((a) => isOurs(a, 'hset', volumeKey())),
          publishIndex: commands.findIndex((a) => isOurs(a, 'publish', channelName())),
          notification,
        };
      } finally {
        monitor.disconnect();
        monitorClient.disconnect();
        subscriber.disconnect();
      }
    }

    it('writes the hash before announcing it, on the parsed path', async () => {
      const id = await seedParsedWorkout('2026-05-05T00:00:00.000Z', [
        { slug: 'bench-press', sets: [{ weight: 60, reps: 5 }] },
      ]);

      const { hsetIndex, publishIndex, notification } = await orderOf(() => publishParsed(id));

      expect(notification).not.toBeNull();
      expect(notification?.iso_week).toBe(week);
      // Both present, and in this order. `toBeGreaterThan`, not `not.toBe`: the
      // point is which came first, and -1 for a missing command would sail
      // through a mere inequality.
      expect(hsetIndex).toBeGreaterThanOrEqual(0);
      expect(publishIndex).toBeGreaterThan(hsetIndex);
    }, 20000);

    it('writes the hash before announcing it, on the deleted path too', async () => {
      // The path whose week cannot be derived — the workout is gone by the time
      // the handler runs, so `iso_week` has to come from the payload.
      const performedAt = '2026-05-06T00:00:00.000Z';
      const id = await seedParsedWorkout(performedAt, [
        { slug: 'squat', sets: [{ weight: 80, reps: 5 }] },
      ]);
      publishParsed(id);
      await new Promise((r) => setTimeout(r, 900));

      await dataSource.query(
        'DELETE FROM sets WHERE workout_exercise_id IN (SELECT id FROM workout_exercises WHERE workout_id = $1)',
        [id],
      );
      await dataSource.query('DELETE FROM workout_exercises WHERE workout_id = $1', [id]);
      await dataSource.query('DELETE FROM workouts WHERE id = $1', [id]);

      const { hsetIndex, publishIndex, notification } = await orderOf(() =>
        publishDeleted(id, performedAt),
      );

      expect(notification?.iso_week).toBe(week);
      expect(hsetIndex).toBeGreaterThanOrEqual(0);
      expect(publishIndex).toBeGreaterThan(hsetIndex);
    }, 20000);
  });
});
