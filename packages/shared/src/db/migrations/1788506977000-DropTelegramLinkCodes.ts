import { MigrationInterface, QueryRunner } from 'typeorm';

// Telegram was descoped from the MVP (spec.md US2, 2026-09-04). The
// telegram_link_codes table (InitialSchema) was never written to — the linking
// flow that would have populated it was never built. Dropping it now, along
// with the TelegramLinkCode entity and the linking-code rate-limit helpers.
// users.telegram_chat_id is a separate column and is left in place.
//
// down() recreates the table exactly as InitialSchema1787297297813 did, so a
// full revert still lands on the original schema.
export class DropTelegramLinkCodes1788506977000 implements MigrationInterface {
  name = 'DropTelegramLinkCodes1788506977000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Postgres drops the FK constraint together with the table.
    await queryRunner.query(`DROP TABLE "telegram_link_codes"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "telegram_link_codes" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "code" text NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "used_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_ffc6d0c8ce6da8035fa1e51a46b" UNIQUE ("code"), CONSTRAINT "PK_b47eff84719ed2ea18041258c23" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "telegram_link_codes" ADD CONSTRAINT "FK_434682c9610bd816ae26a56f023" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }
}
