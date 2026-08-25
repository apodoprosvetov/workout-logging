'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { apiFetchPublic, saveTokens, type StoredTokens } from '../../lib/api-client';

interface AuthFormProps {
  mode: 'register' | 'login';
}

const COPY = {
  register: {
    heading: 'Create an account',
    submitLabel: 'Register',
    submittingLabel: 'Creating account…',
    switchPrompt: 'Already have an account?',
    switchLinkLabel: 'Log in',
    switchHref: '/login',
    path: '/auth/register',
  },
  login: {
    heading: 'Log in',
    submitLabel: 'Log in',
    submittingLabel: 'Logging in…',
    switchPrompt: "Don't have an account?",
    switchLinkLabel: 'Register',
    switchHref: '/register',
    path: '/auth/login',
  },
} as const;

function errorMessage(mode: AuthFormProps['mode'], status: number): string {
  if (mode === 'register' && status === 409) return 'An account with this email already exists.';
  if (mode === 'login' && status === 401) return 'Invalid email or password.';
  if (status === 400) return 'Please check your email and password and try again.';
  return 'Something went wrong. Please try again.';
}

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const copy = COPY[mode];
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const response = await apiFetchPublic(copy.path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        setError(errorMessage(mode, response.status));
        return;
      }
      saveTokens((await response.json()) as StoredTokens);
      router.push('/dashboard');
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 px-6 dark:bg-black">
      <div className="w-full max-w-sm">
        <h1 className="mb-6 text-2xl font-semibold text-black dark:text-zinc-50">{copy.heading}</h1>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Email
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-black focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Password
            <input
              type="password"
              required
              minLength={1}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-black focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
          </label>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="mt-2 rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
          >
            {submitting ? copy.submittingLabel : copy.submitLabel}
          </button>
        </form>
        <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
          {copy.switchPrompt}{' '}
          <Link href={copy.switchHref} className="font-medium text-zinc-950 underline dark:text-zinc-50">
            {copy.switchLinkLabel}
          </Link>
        </p>
      </div>
    </div>
  );
}
