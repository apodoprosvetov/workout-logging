import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { InjectRepository } from '@nestjs/typeorm';
import { Connection } from 'mongoose';
import { Repository } from 'typeorm';

import {
  ChangeNotification,
  Exercise,
  OutboxEvent,
  resolveExercisesInCatalog,
  Workout,
  WORKOUT_DELETED_KEY,
  WORKOUT_DELETED_ROUTING_KEY,
  WORKOUT_UPDATED_KEY,
  WORKOUT_UPDATED_ROUTING_KEY,
  WorkoutDeletedEvent,
  WorkoutExercise,
  WorkoutSet,
  WorkoutStatus,
  WorkoutUpdatedEvent,
} from '@workout-logging/shared';

import { ListWorkoutsQueryDto } from './dto/list-workouts-query.dto';
import { ReplaceWorkoutDto } from './dto/replace-workout.dto';
import { paginate } from '../common/pagination';
import { NotificationsPublisher } from '../events/notifications.publisher';
import { RabbitMqPublisherService } from '../events/rabbitmq-publisher.service';

// Read/CRUD side of workouts — kept separate from IngestionService, which is
// specifically the async raw-text/image -> AI-parse pipeline (RabbitMQ + Mongo
// raw_uploads + GridFS), a different concern entirely.
//
// The edit path spans four files and two processes:
//
// ```
// PUT /api/workouts/:id -> WorkoutsController.replace
//   -> WorkoutsService.replaceById
//        -> findOne({id, userId})              404
//        -> status parsed | needs_review       409
//        -> resolveExercisesInCatalog          400 (every miss) | 503
//        -> transaction: remove tree, insert tree, update workout,
//                        insert OutboxEvent(workout.updated)
//        -> notification.publish(workout.updated)   [outside the commit]
//   OutboxRelayService.sweep -> workout.analytics.q
//     -> worker: recomputeWeek(previous_performed_at), recomputeWeek(performed_at)
// ```
//
// Nothing here publishes to RabbitMQ; the relay does. workout.updated must stay
// bound in setupRabbitMqTopology — an unbound key is confirmed and dropped.
@Injectable()
export class WorkoutsService {
  private readonly logger = new Logger(WorkoutsService.name);

  constructor(
    @InjectRepository(Workout) private readonly workoutRepository: Repository<Workout>,
    @InjectConnection() private readonly mongoConnection: Connection,
    private readonly publisher: RabbitMqPublisherService,
    private readonly notification: NotificationsPublisher,
  ) {}

  // FR-015: every read scoped to the caller — userId is always an equality
  // filter, never taken from the query/path. Sorted/paginated by performedAt
  // (when the workout happened), not createdAt (when it was ingested) — a
  // backlogged entry should sort by its real date, not upload order.
  //
  // `before` (exclusive) / `after` (inclusive) bound performedAt as a
  // half-open [after, before) window — pass both to fetch a single ISO
  // week (after = week start, before = next week start).
  //
  // The sort carries `id` as a tie-break because performedAt alone is not a
  // total order, and ties are the normal case here rather than a rarity: the
  // web form supplies a date, so every workout logged for the same day shares
  // performedAt to the microsecond. Verified against Postgres 16 — the same
  // three tied rows come back A,B,C under a sequential scan and C,B,A under an
  // index scan, so without a tie-break the order flips with the query plan.
  // Offset pagination on top of that would silently skip and repeat rows
  // between pages, so the tie-break is load-bearing, not tidiness.
  async list(userId: string, query: ListWorkoutsQueryDto) {
    const qb = this.workoutRepository
      .createQueryBuilder('w')
      .where('w.userId = :userId', { userId })
      .orderBy('w.performedAt', 'DESC')
      .addOrderBy('w.id', 'DESC');

    // `IN` even for one value, because contracts/api.md promises the
    // single-value form keeps working and an absent parameter keeps returning
    // every status — apps/web calls this route with no filter at all today.
    //
    // `?.length` guards the empty case on purpose: `IN ()` is a SQL syntax
    // error, not an empty result.
    if (query.status?.length) qb.andWhere('w.status IN (:...statuses)', { statuses: query.status });
    if (query.before) qb.andWhere('w.performedAt < :before', { before: new Date(query.before) });
    if (query.after) qb.andWhere('w.performedAt >= :after', { after: new Date(query.after) });

    return paginate(qb, query, (w) => ({
      id: w.id,
      name: w.name,
      source: w.source,
      status: w.status,
      performed_at: w.performedAt.toISOString(),
      created_at: w.createdAt.toISOString(),
    }));
  }

  // 404, not 403, for another user's workout or a nonexistent one — never
  // confirm existence of another user's data (contracts/api.md).
  async getById(userId: string, workoutId: string) {
    const workout = await this.workoutRepository
      .createQueryBuilder('w')
      .leftJoinAndSelect('w.workoutExercises', 'we')
      .leftJoinAndSelect('we.exercise', 'e')
      .leftJoinAndSelect('we.sets', 's')
      .where('w.id = :workoutId', { workoutId })
      .andWhere('w.userId = :userId', { userId })
      .orderBy('we.exerciseOrder', 'ASC')
      .addOrderBy('s.setOrder', 'ASC')
      .getOne();

    if (!workout) {
      throw new NotFoundException();
    }

    return toWorkoutDetail(workout);
  }

  // 404, not 403, for another user's workout or a nonexistent one — never
  // confirm existence of another user's data (contracts/api.md).
  //
  // Cascade is done in the ORM, not the DB (the FKs are ON DELETE NO ACTION):
  // load the graph and remove() children before parent, all in one transaction
  // so a mid-delete failure rolls back cleanly. A bare workoutRepository.delete
  // on `workouts` would hit a foreign-key violation from the child
  // workout_exercises / sets rows — and TypeORM's relation `cascade: ['remove']`
  // option does NOT propagate a repository.remove() to @OneToMany children
  // (it only governs the save path), so the removal is spelled out here.
  // The `exercises` catalog is a ManyToOne reference, not a child — untouched.
  async deleteById(userId: string, workoutId: string) {
    const workout = await this.workoutRepository.findOne({
      where: { id: workoutId, userId },
      relations: { workoutExercises: { sets: true } },
    });

    if (!workout) {
      throw new NotFoundException();
    }

    await this.workoutRepository.manager.transaction(async (manager) => {
      const sets = workout.workoutExercises.flatMap((we) => we.sets);
      if (sets.length > 0) await manager.remove(sets);
      if (workout.workoutExercises.length > 0) await manager.remove(workout.workoutExercises);
      await manager.remove(workout);
    });

    // performedAt is read off the entity loaded above, before the rows go: the
    // consumer needs the week and has nothing left to look it up from.
    const event: WorkoutDeletedEvent = {
      type: 'workout.deleted',
      event_id: randomUUID(),
      user_id: userId,
      workout_id: workoutId,
      performed_at: workout.performedAt.toISOString(),
      occurred_at: new Date().toISOString(),
    };

    // Published after the commit, not inside it — a rolled-back transaction must
    // not announce a deletion that did not happen.
    //
    // The gap that leaves: if this process dies between commit and publish, the
    // workout is gone but its volume stays in the cache until something else
    // recomputes that week (or the 120-day TTL expires). An outbox would close
    // it; that is disproportionate here, and the apps/api read path falls back
    // to Postgres on a cache miss, so nothing is permanently wrong — only stale.
    await this.publisher.publish(WORKOUT_DELETED_ROUTING_KEY, event);

    const notification: ChangeNotification = {
      type: WORKOUT_DELETED_KEY,
      event_id: randomUUID(),
      user_id: userId,
      workout_id: workoutId,
      occurred_at: new Date().toISOString(),
      performed_at: workout.performedAt.toISOString(),
    };
    await this.notification.publish(notification);
  }

  // Full replacement, not a patch: getById exposes no exercise or set ids, so a
  // caller has no stable identity to address one with.
  async replaceById(userId: string, workoutId: string, dto: ReplaceWorkoutDto) {
    const workout = await this.workoutRepository.findOne({ where: { id: workoutId, userId } });

    if (!workout) throw new NotFoundException();

    // pending is the one that matters: the parser is still writing to this
    // workout and would overwrite the edit.
    if (workout.status !== WorkoutStatus.PARSED && workout.status !== WorkoutStatus.NEEDS_REVIEW) {
      throw new ConflictException(
        workout.status === WorkoutStatus.PENDING
          ? 'This workout is still being processed and cannot be edited yet.'
          : 'This workout has no parsed content to edit.',
      );
    }

    const names = dto.exercises.map((exercise) => exercise.name);
    let resolutions;
    try {
      resolutions = await resolveExercisesInCatalog(this.mongoConnection, names);
    } catch (err) {
      this.logger.error(
        'exercise catalog lookup failed during replace',
        err instanceof Error ? err.stack : undefined,
      );
      // 503, never 400: an unreachable catalog makes every name look unmatched,
      // and blaming the caller for an outage sends them fixing the wrong thing.
      throw new ServiceUnavailableException(
        'Could not check the exercise catalog. Nothing was saved.',
      );
    }

    // Every miss, not the first — the caller fixes them in one pass.
    const unresolved = resolutions.filter((r) => r.entry === null).map((r) => r.submittedName);
    if (unresolved.length > 0) {
      throw new BadRequestException({
        message: 'These exercises are not in the catalog.',
        unresolved_exercises: [...new Set(unresolved)],
      });
    }

    const performedAt = new Date(dto.performed_at);
    const occurredAt = new Date();

    await this.workoutRepository.manager.transaction(async (manager) => {
      // Lock the row and re-read it here, rather than trusting the snapshot
      // above. Two concurrent replacements would otherwise each delete the tree
      // their own snapshot saw and insert their own, and the second delete —
      // matching nothing — raises no error, leaving the workout with both.
      const locked = await manager.findOne(Workout, {
        where: { id: workoutId, userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked) throw new NotFoundException();
      if (locked.status !== WorkoutStatus.PARSED && locked.status !== WorkoutStatus.NEEDS_REVIEW) {
        throw new ConflictException('This workout can no longer be edited.');
      }

      // Read before the update overwrites it: after the commit nothing knows
      // which week the workout left.
      const event: WorkoutUpdatedEvent = {
        type: 'workout.updated',
        event_id: randomUUID(),
        user_id: userId,
        workout_id: workoutId,
        previous_performed_at: locked.performedAt.toISOString(),
        performed_at: performedAt.toISOString(),
        occurred_at: occurredAt.toISOString(),
      };

      // By workout_id, not by the ids a snapshot happened to hold: under the
      // lock this is what "everything currently attached" means.
      await manager.query(
        `DELETE FROM sets WHERE workout_exercise_id IN
           (SELECT id FROM workout_exercises WHERE workout_id = $1)`,
        [workoutId],
      );
      await manager.delete(WorkoutExercise, { workoutId });

      const exerciseRepository = manager.getRepository(Exercise);
      for (const [index, submitted] of dto.exercises.entries()) {
        const entry = resolutions[index].entry as NonNullable<(typeof resolutions)[number]['entry']>;

        // `exercises` mirrors only the catalog entries some workout has used, so
        // a first use has no row yet.
        let exercise = await exerciseRepository.findOneBy({ slug: entry.slug });
        if (!exercise) {
          exercise = await exerciseRepository.save(
            exerciseRepository.create({ slug: entry.slug, name: entry.name }),
          );
        }

        const workoutExercise = await manager.save(
          manager.create(WorkoutExercise, {
            workoutId,
            exerciseId: exercise.id,
            exerciseOrder: index + 1,
          }),
        );

        await manager.save(
          submitted.sets.map((set, setIndex) =>
            manager.create(WorkoutSet, {
              workoutExerciseId: workoutExercise.id,
              setOrder: setIndex + 1,
              weight: String(set.weight),
              reps: set.reps,
              unit: set.unit,
            }),
          ),
        );
      }

      // Unconditionally parsed: the unmatched exercise that would call for
      // needs_review cannot survive the check above.
      await manager.update(Workout, workoutId, {
        name: dto.name ?? null,
        performedAt,
        status: WorkoutStatus.PARSED,
      });

      // Same commit as the content: losing this leaves both weeks wrong, and the
      // analytics read path serves a present Redis hash verbatim until its TTL.
      await manager.insert(OutboxEvent, {
        eventId: event.event_id,
        routingKey: WORKOUT_UPDATED_ROUTING_KEY,
        payload: event,
        occurredAt,
        publishedAt: null,
      });
    });

    // Not workout.settled: apps/web reads a settle as extraction completing, and
    // this workout was never in flight.
    const notification: ChangeNotification = {
      type: WORKOUT_UPDATED_KEY,
      event_id: randomUUID(),
      user_id: userId,
      workout_id: workoutId,
      occurred_at: new Date().toISOString(),
    };
    await this.notification.publish(notification);

    return this.getById(userId, workoutId);
  }
}

// Shared by getById and replaceById so an edit's response cannot drift from a
// read of the same workout.
function toWorkoutDetail(workout: Workout) {
  return {
    id: workout.id,
    name: workout.name,
    status: workout.status,
    source: workout.source,
    performed_at: workout.performedAt.toISOString(),
    exercises: workout.workoutExercises.map((we) => ({
      name: we.exercise.name,
      order: we.exerciseOrder,
      sets: we.sets.map((s) => ({
        order: s.setOrder,
        weight: Number(s.weight),
        reps: s.reps,
        unit: s.unit,
      })),
    })),
  };
}
