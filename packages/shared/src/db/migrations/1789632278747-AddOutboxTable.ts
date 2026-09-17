import { MigrationInterface, QueryRunner } from 'typeorm';

// The transactional outbox (specs/004 T057). A row lands here in the same
// Postgres transaction as the state it describes (T058); a relay publishes it
// to RabbitMQ afterwards and stamps published_at (T059). See the OutboxEvent
// entity for why each column is shaped the way it is.
//
// The index is partial — `WHERE published_at IS NULL` — because the relay only
// ever reads unpublished rows and those are a handful at any moment, while
// published rows accumulate forever. A full index on occurred_at would grow
// with the whole table to serve a query that never looks at most of it.
//
// As with AddIndexesForWorkoutReadPaths, AddPerformedAtExplicitToWorkouts and
// AddIdToWorkoutReadPathIndex before it, `migration:generate` emitted a batch
// of unrelated churn alongside the two statements that matter: DROP/SET DEFAULT
// on every uuid primary key (it cannot textually compare gen_random_uuid()
// against itself), a full FK drop-and-recreate cycle, a rename of the
// hand-named workout_exercises index from AddExerciseIdIndexToWorkoutExercises,
// and the known drop-and-recreate of the workouts read-path index that
// AddIdToWorkoutReadPathIndex documents. All cosmetic, none of it this change —
// trimmed to the CREATE TABLE and its index. Both names are the generated ones,
// so nothing here renames on the next generate.
export class AddOutboxTable1789632278747 implements MigrationInterface {
  name = 'AddOutboxTable1789632278747';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "outbox" ("event_id" uuid NOT NULL, "routing_key" text NOT NULL, "payload" jsonb NOT NULL, "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL, "published_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_cc0c9e40998e45ecfc5e313429d" PRIMARY KEY ("event_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_55c1af410f46defaf0e2c5b978" ON "outbox" ("occurred_at") WHERE "published_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Postgres drops the index together with the table; the explicit DROP INDEX
    // keeps the reversal readable as the mirror of up().
    await queryRunner.query(`DROP INDEX "public"."IDX_55c1af410f46defaf0e2c5b978"`);
    await queryRunner.query(`DROP TABLE "outbox"`);
  }
}
