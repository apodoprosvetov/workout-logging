import { MigrationInterface, QueryRunner } from 'typeorm';

// GET /workouts now orders by performed_at DESC, id DESC — the id tie-break
// makes the ordering total, which offset pagination requires (specs/003
// research #2). This widens the read-path index to match.
//
// Ascending, no per-column direction. The ordering is uniformly descending, so
// Postgres reads the btree backwards; measured with EXPLAIN on the real table,
// the two-column index leaves an `Incremental Sort` on top of the index scan,
// and this one leaves a bare `Index Scan Backward` with no sort at all. A DESC
// index would only matter for a mixed-direction ORDER BY — and TypeORM's
// @Index cannot express one, so it would also put the schema permanently out
// of step with the entity.
//
// As with AddIndexesForWorkoutReadPaths and AddPerformedAtExplicitToWorkouts,
// `migration:generate` also emitted a batch of unrelated churn: DROP/SET
// DEFAULT on every uuid primary key (it cannot textually compare the
// gen_random_uuid() default against itself), a full FK drop/recreate cycle,
// and a rename of the hand-named workout_exercises index from
// AddExerciseIdIndexToWorkoutExercises. All cosmetic, none of it this change —
// trimmed to the two statements that matter. The index name is the generated
// one, not hand-picked, so nothing here renames on the next generate.
//
// Known follow-on, verified after applying this: `migration:generate` will
// keep emitting a drop-and-recreate of this index with *identical* columns.
// TypeORM reads the index back ordered by entity column declaration —
// `(id, user_id, performed_at)`, since `id` is declared first — and compares
// that against the decorator's `['userId', 'performedAt', 'id']`, so the two
// never match textually even though the database is correct
// (`btree (user_id, performed_at, id)`, confirmed via pg_indexes). Trim that
// pair of statements out of future generated migrations the same way. Marking
// the decorator `{ synchronize: false }` would silence it permanently, at the
// cost of TypeORM no longer tracking the index at all.
export class AddIdToWorkoutReadPathIndex1788872432152 implements MigrationInterface {
  name = 'AddIdToWorkoutReadPathIndex1788872432152';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_e6a14b328d153b3050dd0773af"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_92387870c24d346a135a8c45d6" ON "workouts" ("user_id", "performed_at", "id") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_92387870c24d346a135a8c45d6"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_e6a14b328d153b3050dd0773af" ON "workouts" ("user_id", "performed_at") `,
    );
  }
}
