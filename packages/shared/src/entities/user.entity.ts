import { Column, CreateDateColumn, Entity, OneToMany, PrimaryColumn } from 'typeorm';
import { RefreshToken } from './refresh-token.entity';
import { Workout } from './workout.entity';

@Entity('users')
export class User {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'text', unique: true })
  email!: string;

  @Column({ type: 'text' })
  passwordHash!: string;

  // Legacy Telegram column (bigint → string from node-postgres). Telegram was
  // descoped (spec.md US2); the linking flow that would set this was never built
  // and telegram_link_codes has been dropped. Kept for now — a follow-up
  // migration can remove the column + its unique constraint.
  @Column({ type: 'bigint', nullable: true, unique: true })
  telegramChatId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @OneToMany(() => Workout, (workout) => workout.user)
  workouts!: Workout[];

  @OneToMany(() => RefreshToken, (refreshToken) => refreshToken.user)
  refreshTokens!: RefreshToken[];
}
