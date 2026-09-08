import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { WorkoutExercise } from './workout-exercise.entity';

export enum SetUnit {
  KG = 'kg',
  LB = 'lb',
}

// Named WorkoutSet, not Set, to avoid shadowing the built-in Set collection type.
@Entity('sets')
export class WorkoutSet {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  // GET /workouts/:id joins on this FK column — see workout-exercise.entity.ts's
  // workoutId index for why this needs one too.
  @Index()
  @Column()
  workoutExerciseId!: string;

  @ManyToOne(() => WorkoutExercise, (workoutExercise) => workoutExercise.sets)
  @JoinColumn({ name: 'workout_exercise_id' })
  workoutExercise!: WorkoutExercise;

  @Column()
  setOrder!: number;

  // numeric columns come back as string from node-postgres (avoids float precision loss).
  @Column({ type: 'numeric' })
  weight!: string;

  @Column({ type: 'int' })
  reps!: number;

  @Column({ type: 'enum', enum: SetUnit, default: SetUnit.KG })
  unit!: SetUnit;
}
