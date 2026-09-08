import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Workout } from '@workout-logging/shared';

import { ListWorkoutsQueryDto } from './dto/list-workouts-query.dto';
import { paginate } from '../common/pagination';

// Read/CRUD side of workouts (list/get today; room for delete, patch, and a
// manual/non-AI-ingested create later) — kept separate from IngestionService,
// which is specifically the async raw-text/image -> AI-parse pipeline
// (RabbitMQ + Mongo raw_uploads + GridFS), a different concern entirely.
@Injectable()
export class WorkoutsService {
  constructor(@InjectRepository(Workout) private readonly workoutRepository: Repository<Workout>) {}

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

    if (query.status) qb.andWhere('w.status = :status', { status: query.status });
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
  }
}
