'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import { WorkoutEditForm } from '@features/workouts';

function WorkoutEditPageContent() {
  const id = useSearchParams().get('id');

  if (!id) {
    return <p className="px-6 py-10 text-sm text-zinc-500">No workout to edit.</p>;
  }
  return <WorkoutEditForm id={id} />;
}

// Suspense is required, not stylistic: under `output: 'export'` a static page
// reading useSearchParams outside a boundary fails the production build.
export default function WorkoutEditPage() {
  return (
    <Suspense fallback={<div className="px-6 py-10 text-sm text-zinc-500">Loading…</div>}>
      <WorkoutEditPageContent />
    </Suspense>
  );
}
