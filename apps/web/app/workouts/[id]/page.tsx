import { WorkoutDetail } from './workout-detail';

export default async function WorkoutDetailPage(props: PageProps<'/workouts/[id]'>) {
  const { id } = await props.params;
  return <WorkoutDetail id={id} />;
}
