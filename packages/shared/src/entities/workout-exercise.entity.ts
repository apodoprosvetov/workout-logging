import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryColumn } from 'typeorm';
import { Exercise } from './exercise.entity';
import { Workout } from './workout.entity';
import { WorkoutSet } from './set.entity';

@Entity('workout_exercises')
export class WorkoutExercise {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  // GET /workouts/:id joins on this FK column — TypeORM doesn't index FK
  // columns automatically, so without this the join is a seq scan of the
  // whole table once it's not near-empty.
  @Index()
  @Column()
  workoutId!: string;

  @ManyToOne(() => Workout, (workout) => workout.workoutExercises)
  @JoinColumn({ name: 'workout_id' })
  workout!: Workout;

  @Column()
  exerciseId!: string;

  @ManyToOne(() => Exercise, (exercise) => exercise.workoutExercises)
  @JoinColumn({ name: 'exercise_id' })
  exercise!: Exercise;

  @Column()
  exerciseOrder!: number;

  @OneToMany(() => WorkoutSet, (set) => set.workoutExercise)
  sets!: WorkoutSet[];
}
