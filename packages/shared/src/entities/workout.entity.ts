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

// GET /workouts filters by userId and orders by performedAt DESC, id DESC —
// the id tie-break makes the ordering total, which offset pagination requires
// (specs/003 research #2). This composite index matches that access pattern
// exactly.
//
// Ascending, with no per-column direction: TypeORM's @Index cannot express
// DESC, and it does not need to. The ordering is uniformly descending, so
// Postgres reads this btree backwards and the sort disappears entirely —
// confirmed with EXPLAIN, which shows a bare `Index Scan Backward` here versus
// an `Incremental Sort` on top when the index stops at performedAt. A DESC
// index would only matter for a mixed-direction ORDER BY, and would put the
// schema permanently out of step with what this decorator can declare.
@Index(['userId', 'performedAt', 'id'])
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

  // Deleting a workout also deletes its workout_exercises and their sets — done
  // in the ORM (WorkoutsService.deleteById), not the DB (FKs are ON DELETE
  // NO ACTION). No `cascade` option here: TypeORM's relation cascade does not
  // propagate repository.remove() to @OneToMany children, only the save path.
  @OneToMany(() => WorkoutExercise, (workoutExercise) => workoutExercise.workout)
  workoutExercises!: WorkoutExercise[];
}
