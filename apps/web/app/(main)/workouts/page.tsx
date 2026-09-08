'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import { WorkoutDetail, WorkoutList } from '@features/workouts';

function WorkoutsPageContent() {
  const id = useSearchParams().get('id') || undefined;

  return id ? <WorkoutDetail id={id} /> : <WorkoutList />;
}

export default function WorkoutsPage() {
  return (
    <Suspense fallback={<div className="px-6 py-10 text-sm text-zinc-500">Loading…</div>}>
      <WorkoutsPageContent />
    </Suspense>
  );
}
