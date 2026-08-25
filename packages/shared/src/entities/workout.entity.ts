import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryColumn } from 'typeorm';
import { User } from './user.entity';
import { WorkoutExercise } from './workout-exercise.entity';

export enum WorkoutSource {
  WEB = 'web',
  TELEGRAM = 'telegram',
}

export enum WorkoutStatus {
  PENDING = 'pending',
  PARSED = 'parsed',
  NEEDS_REVIEW = 'needs_review',
  FAILED = 'failed',
}

// GET /workouts filters by userId and sorts/paginates by performedAt (T033) —
// this composite index matches that access pattern exactly (Postgres can
// scan it backwards for the DESC sort within a matching userId).
@Index(['userId', 'performedAt'])
@Entity('workouts')
export class Workout {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column()
  userId!: string;

  @ManyToOne(() => User, (user) => user.workouts)
  @JoinColumn({ name: 'user_id' })
  user!: User;

  // Extracted by the parser worker from raw text/image content when present
  // (e.g. "Низ А"); never invented from exercise types (spec.md Assumptions
  // still defers pure AI-inferred naming beyond MVP). Stays null otherwise.
  @Column({ type: 'text', nullable: true })
  name!: string | null;

  @Column({ type: 'enum', enum: WorkoutSource })
  source!: WorkoutSource;

  // Mirrors raw_uploads.text / raw_uploads.image_refs presence (research.md #8, #11).
  @Column()
  hasText!: boolean;

  @Column()
  hasImage!: boolean;

  // Points to raw_uploads._id in MongoDB.
  @Column({ type: 'text' })
  rawInputRef!: string;

  @Column({ type: 'enum', enum: WorkoutStatus, default: WorkoutStatus.PENDING })
  status!: WorkoutStatus;

  @Column({ type: 'timestamptz' })
  performedAt!: Date;

  // True only when the caller explicitly passed performed_at on POST /workouts.
  // The parser worker only overwrites performedAt with a date extracted from the
  // raw text/image when this is false — an explicit caller value always wins.
  @Column({ default: false })
  performedAtExplicit!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @OneToMany(() => WorkoutExercise, (workoutExercise) => workoutExercise.workout)
  workoutExercises!: WorkoutExercise[];
}
