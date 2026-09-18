'use client';

import Link from 'next/link';

import type { EditScreenWithoutEditor } from './lib/screen';

// Text, not JSX, in the record: an object of elements would build every branch
// on every render, and these four differ only in wording.
const MESSAGES: Record<EditScreenWithoutEditor['status'], string> = {
  loading: 'Loading…',
  'not-found': 'Workout not found.',
  'not-editable':
    'This workout cannot be edited — it is still being processed, or it has no parsed content to correct.',
  error: 'Could not load this workout. Please try again.',
};

// Every screen the edit form shows instead of the editor. Only `error` offers a
// retry: the other three do not change by asking again.
export function EditScreenMessage({
  screen,
  workoutId,
  onRetry,
}: {
  screen: EditScreenWithoutEditor;
  workoutId: string;
  onRetry: () => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-10">
      <Link
        href={`/workouts?id=${workoutId}`}
        className="text-sm font-medium text-zinc-600 underline dark:text-zinc-400"
      >
        ← Back to workout
      </Link>

      {screen.status === 'error' ? (
        <div className="flex items-center justify-between rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          <span>{MESSAGES.error}</span>
          <button type="button" onClick={onRetry} className="font-medium underline">
            Retry
          </button>
        </div>
      ) : (
        <p className="text-sm text-zinc-500">{MESSAGES[screen.status]}</p>
      )}
    </div>
  );
}
