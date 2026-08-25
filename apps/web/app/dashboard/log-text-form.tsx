'use client';

import { useId, useState } from 'react';
import { apiFetch } from '../../lib/api-client';

interface LogTextFormProps {
  onLogged: () => void;
}

function errorMessage(status: number): string {
  if (status === 429) return "You're logging too quickly — please wait a moment and try again.";
  if (status === 400) return 'Please enter some workout text.';
  return 'Something went wrong. Please try again.';
}

export function LogTextForm({ onLogged }: LogTextFormProps) {
  const textId = useId();
  const dateId = useId();
  const [text, setText] = useState('');
  const [performedAt, setPerformedAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const body = new FormData();
      body.set('text', text);
      if (performedAt) body.set('performed_at', performedAt);

      // FormData body: no content-type header here — fetch sets the correct
      // multipart boundary itself; apps/api's POST /workouts expects
      // multipart, not JSON (T030, @fastify/multipart keyValues mode).
      const response = await apiFetch('/workouts', { method: 'POST', body });
      if (!response.ok) {
        setError(errorMessage(response.status));
        return;
      }
      setText('');
      setPerformedAt('');
      onLogged();
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
    >
      <label htmlFor={textId} className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Log a workout
      </label>
      <textarea
        id={textId}
        required
        rows={4}
        placeholder="Push day: bench press 80kg x8, x8, x6; overhead press 40kg x10, x10, x8"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-black focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
      />
      <label htmlFor={dateId} className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Date (optional — defaults to today, or a date found in the text)
      </label>
      <input
        id={dateId}
        type="date"
        value={performedAt}
        onChange={(e) => setPerformedAt(e.target.value)}
        className="w-fit rounded-md border border-zinc-300 bg-white px-3 py-2 text-black focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
      />
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={submitting || text.trim() === ''}
        className="w-fit rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
      >
        {submitting ? 'Logging…' : 'Log workout'}
      </button>
    </form>
  );
}
