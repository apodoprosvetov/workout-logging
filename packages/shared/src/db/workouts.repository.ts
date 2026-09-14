import { Workout, WorkoutStatus } from '../entities';
import { mapReturningOne } from './returning';

import type { DataSource, EntityManager } from 'typeorm';

/**
 * Queries and mutations over `workouts` that more than one caller needs.
 *
 * Lives here rather than beside a caller because both apps reach this table:
 * `apps/api` owns creation and deletion, `apps/worker` owns the transitions out
 * of `pending`. Keeping the guarded ones together means the reasoning behind a
 * guard is written once, not mirrored into whichever file happened to need it —
 * `markFailed` was previously in `apps/worker/src/parser/retry.ts`, a module
 * about retry tiers and dead-lettering, which is not where a row mutation
 * belongs.
 *
 * Built with `.extend()` rather than `class ... extends Repository<Workout>`
 * because `apps/worker` has no DI container: `extend` takes the DataSource it
 * is given, while the class form has to be constructed with an EntityManager by
 * hand at every call site.
 */
export function workoutsRepository(source: DataSource | EntityManager) {
  return source.getRepository(Workout).extend({
    /**
     * Move a workout to `failed`, but only if it is still `pending`.
     *
     * Returns the data a `workout.settled` notification needs, or `null` when
     * the guard skipped the update — which means the workout already reached a
     * terminal status, so a redelivered message must not announce it twice.
     *
     * The guard is in the `WHERE`, not a read-then-write: two redeliveries
     * racing would both see `pending` and both write, and the later one would
     * stomp a status the first had already settled.
     */
    async markFailed(workoutId: string): Promise<Pick<Workout, 'userId' | 'performedAt'> | null> {
      // One list, used twice: the statement asks for these columns and the
      // mapper types the result by them, so the two cannot drift apart.
      const columns = ['userId', 'performedAt'] as const;

      const result = await this.createQueryBuilder()
        .update(Workout)
        .set({ status: WorkoutStatus.FAILED })
        .where('id = :id AND status = :pendingStatus', {
          id: workoutId,
          pendingStatus: WorkoutStatus.PENDING,
        })
        .returning([...columns])
        .execute();

      // RETURNING hands back raw rows keyed by column name; mapReturningOne
      // converts them using TypeORM's own metadata. See db/returning.ts for why
      // neither `generatedMaps` nor `manager.create` does this.
      //
      // `null` means the guard matched nothing — not that the row was empty.
      return mapReturningOne(this.manager, Workout, result.raw, columns);
    },
  });
}
