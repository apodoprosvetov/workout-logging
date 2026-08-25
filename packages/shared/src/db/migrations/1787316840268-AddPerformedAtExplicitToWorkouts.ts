import { MigrationInterface, QueryRunner } from "typeorm";

// Note: `migration:generate` also emitted a batch of DROP/SET DEFAULT and
// FK drop/recreate statements for unrelated columns — a cosmetic TypeORM
// diffing artifact (it can't textually compare the gen_random_uuid() default
// expression against itself), verified against the live DB to already match
// the entities exactly. Trimmed down to the one real change.
export class AddPerformedAtExplicitToWorkouts1787316840268 implements MigrationInterface {
    name = 'AddPerformedAtExplicitToWorkouts1787316840268'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "workouts" ADD "performed_at_explicit" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "workouts" DROP COLUMN "performed_at_explicit"`);
    }

}
