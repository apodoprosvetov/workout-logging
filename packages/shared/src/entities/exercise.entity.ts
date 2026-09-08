import { Column, Entity, OneToMany, PrimaryColumn } from 'typeorm';

import { WorkoutExercise } from './workout-exercise.entity';

@Entity('exercises')
export class Exercise {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  // Join key with MongoDB exercise_catalog (data-model.md).
  @Column({ type: 'text', unique: true })
  slug!: string;

  @Column({ type: 'text' })
  name!: string;

  @OneToMany(() => WorkoutExercise, (workoutExercise) => workoutExercise.exercise)
  workoutExercises!: WorkoutExercise[];
}
