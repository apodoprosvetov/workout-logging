'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

import { WorkoutDetail } from './workout-detail';

function WorkoutDetailContent() {
  const id = useSearchParams().get('id') || undefined;

  if (!id) {
    return <div className="text-sm text-zinc-600 dark:text-zinc-400">Workout not found</div>;
  }

  return <WorkoutDetail id={id} />;
}

export default function WorkoutDetailPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <WorkoutDetailContent />
    </Suspense>
  );
}