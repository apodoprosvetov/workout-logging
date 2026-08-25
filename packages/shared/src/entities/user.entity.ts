import { Column, CreateDateColumn, Entity, OneToMany, PrimaryColumn } from 'typeorm';
import { RefreshToken } from './refresh-token.entity';
import { TelegramLinkCode } from './telegram-link-code.entity';
import { Workout } from './workout.entity';

@Entity('users')
export class User {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'text', unique: true })
  email!: string;

  @Column({ type: 'text' })
  passwordHash!: string;

  // bigint columns come back as string from node-postgres (avoids unsafe-integer loss).
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

  @OneToMany(() => TelegramLinkCode, (linkCode) => linkCode.user)
  telegramLinkCodes!: TelegramLinkCode[];
}
