import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { User } from './user.entity';

@Entity('telegram_link_codes')
export class TelegramLinkCode {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column()
  userId!: string;

  @ManyToOne(() => User, (user) => user.telegramLinkCodes)
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'text', unique: true })
  code!: string;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  usedAt!: Date | null;
}
