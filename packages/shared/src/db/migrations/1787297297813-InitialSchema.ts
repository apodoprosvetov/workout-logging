import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1787297297813 implements MigrationInterface {
    name = 'InitialSchema1787297297813'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "refresh_tokens" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "token_hash" text NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "revoked_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_7d8bee0204106019488c4c50ffa" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "telegram_link_codes" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "code" text NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "used_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_ffc6d0c8ce6da8035fa1e51a46b" UNIQUE ("code"), CONSTRAINT "PK_b47eff84719ed2ea18041258c23" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "exercises" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "slug" text NOT NULL, "name" text NOT NULL, CONSTRAINT "UQ_39b440305ccf965ef366de53ab8" UNIQUE ("slug"), CONSTRAINT "PK_c4c46f5fa89a58ba7c2d894e3c3" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."sets_unit_enum" AS ENUM('kg', 'lb')`);
        await queryRunner.query(`CREATE TABLE "sets" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "workout_exercise_id" uuid NOT NULL, "set_order" integer NOT NULL, "weight" numeric NOT NULL, "reps" integer NOT NULL, "unit" "public"."sets_unit_enum" NOT NULL DEFAULT 'kg', CONSTRAINT "PK_5d15ed8b3e2a5cb6e9c9921d056" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "workout_exercises" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "workout_id" uuid NOT NULL, "exercise_id" uuid NOT NULL, "exercise_order" integer NOT NULL, CONSTRAINT "PK_377f9ead6fd69b29f0d0feb1028" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."workouts_source_enum" AS ENUM('web', 'telegram')`);
        await queryRunner.query(`CREATE TYPE "public"."workouts_status_enum" AS ENUM('pending', 'parsed', 'needs_review', 'failed')`);
        await queryRunner.query(`CREATE TABLE "workouts" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "name" text, "source" "public"."workouts_source_enum" NOT NULL, "has_text" boolean NOT NULL, "has_image" boolean NOT NULL, "raw_input_ref" text NOT NULL, "status" "public"."workouts_status_enum" NOT NULL DEFAULT 'pending', "performed_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_5b2319bf64a674d40237dbb1697" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "email" text NOT NULL, "password_hash" text NOT NULL, "telegram_chat_id" bigint, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "UQ_d008c578c984d10bd5fc4f0c90e" UNIQUE ("telegram_chat_id"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "processed_events" ("event_id" uuid NOT NULL, "processed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_585a690352092645ee665d70ac2" PRIMARY KEY ("event_id"))`);
        await queryRunner.query(`ALTER TABLE "refresh_tokens" ADD CONSTRAINT "FK_3ddc983c5f7bcf132fd8732c3f4" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "telegram_link_codes" ADD CONSTRAINT "FK_434682c9610bd816ae26a56f023" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "sets" ADD CONSTRAINT "FK_31a6f55b3ecb4516de1970f5c94" FOREIGN KEY ("workout_exercise_id") REFERENCES "workout_exercises"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "workout_exercises" ADD CONSTRAINT "FK_7e6040e931b008308aaddbb7d32" FOREIGN KEY ("workout_id") REFERENCES "workouts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "workout_exercises" ADD CONSTRAINT "FK_9a0656f321d9a96de2eb685e85a" FOREIGN KEY ("exercise_id") REFERENCES "exercises"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "workouts" ADD CONSTRAINT "FK_2df679279a7ac263bcff20c78dd" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "workouts" DROP CONSTRAINT "FK_2df679279a7ac263bcff20c78dd"`);
        await queryRunner.query(`ALTER TABLE "workout_exercises" DROP CONSTRAINT "FK_9a0656f321d9a96de2eb685e85a"`);
        await queryRunner.query(`ALTER TABLE "workout_exercises" DROP CONSTRAINT "FK_7e6040e931b008308aaddbb7d32"`);
        await queryRunner.query(`ALTER TABLE "sets" DROP CONSTRAINT "FK_31a6f55b3ecb4516de1970f5c94"`);
        await queryRunner.query(`ALTER TABLE "telegram_link_codes" DROP CONSTRAINT "FK_434682c9610bd816ae26a56f023"`);
        await queryRunner.query(`ALTER TABLE "refresh_tokens" DROP CONSTRAINT "FK_3ddc983c5f7bcf132fd8732c3f4"`);
        await queryRunner.query(`DROP TABLE "processed_events"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP TABLE "workouts"`);
        await queryRunner.query(`DROP TYPE "public"."workouts_status_enum"`);
        await queryRunner.query(`DROP TYPE "public"."workouts_source_enum"`);
        await queryRunner.query(`DROP TABLE "workout_exercises"`);
        await queryRunner.query(`DROP TABLE "sets"`);
        await queryRunner.query(`DROP TYPE "public"."sets_unit_enum"`);
        await queryRunner.query(`DROP TABLE "exercises"`);
        await queryRunner.query(`DROP TABLE "telegram_link_codes"`);
        await queryRunner.query(`DROP TABLE "refresh_tokens"`);
    }

}
