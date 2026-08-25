import { MigrationInterface, QueryRunner } from "typeorm";

// Note: `migration:generate` also emitted a batch of DROP/SET DEFAULT and FK
// drop/recreate statements for unrelated columns — the same cosmetic TypeORM
// diffing artifact as AddPerformedAtExplicitToWorkouts (it can't textually
// compare the gen_random_uuid() default expression against itself). Trimmed
// down to the real change: three indexes for GET /workouts and
// GET /workouts/:id's join/filter/sort columns (no FK column had an index —
// TypeORM doesn't add one automatically).
export class AddIndexesForWorkoutReadPaths1787324762581 implements MigrationInterface {
    name = 'AddIndexesForWorkoutReadPaths1787324762581'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE INDEX "IDX_31a6f55b3ecb4516de1970f5c9" ON "sets" ("workout_exercise_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_7e6040e931b008308aaddbb7d3" ON "workout_exercises" ("workout_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_e6a14b328d153b3050dd0773af" ON "workouts" ("user_id", "performed_at") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_e6a14b328d153b3050dd0773af"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7e6040e931b008308aaddbb7d3"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_31a6f55b3ecb4516de1970f5c9"`);
    }

}
