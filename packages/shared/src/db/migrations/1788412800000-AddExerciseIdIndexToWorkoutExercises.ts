import { MigrationInterface, QueryRunner } from 'typeorm';

// workout_exercises.exercise_id is a FK with no index — TypeORM doesn't add one
// automatically (same gap as AddIndexesForWorkoutReadPaths). The weekly-volume
// aggregation (T047) doesn't need it, but per-exercise analytics (spec 003:
// "show me my bench press history" -> WHERE we.exercise_id = X) will, and an
// un-indexed FK also forces a full workout_exercises scan on any exercises-row
// delete. Cheap to add now.
export class AddExerciseIdIndexToWorkoutExercises1788412800000 implements MigrationInterface {
  name = 'AddExerciseIdIndexToWorkoutExercises1788412800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_workout_exercises_exercise_id" ON "workout_exercises" ("exercise_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_workout_exercises_exercise_id"`);
  }
}
