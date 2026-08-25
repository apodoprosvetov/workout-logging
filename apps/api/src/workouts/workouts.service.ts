import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Workout } from '@workout-logging/shared';
import { Repository } from 'typeorm';
import { ListWorkoutsQueryDto } from './dto/list-workouts-query.dto';

const DEFAULT_LIMIT = 20;

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
  async list(userId: string, query: ListWorkoutsQueryDto) {
    const qb = this.workoutRepository
      .createQueryBuilder('w')
      .where('w.userId = :userId', { userId })
      .orderBy('w.performedAt', 'DESC')
      .limit(query.limit ?? DEFAULT_LIMIT);

    if (query.status) qb.andWhere('w.status = :status', { status: query.status });
    if (query.before) qb.andWhere('w.performedAt < :before', { before: new Date(query.before) });

    const workouts = await qb.getMany();
    return {
      workouts: workouts.map((w) => ({
        id: w.id,
        name: w.name,
        source: w.source,
        status: w.status,
        performed_at: w.performedAt.toISOString(),
        created_at: w.createdAt.toISOString(),
      })),
    };
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
}
