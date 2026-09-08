// Imported by app/(main)/layout.tsx and app/(auth)/layout.tsx, which are
// Server Components — a root layout exporting `metadata` cannot be a Client
// Component, so the client boundary has to be declared here rather than
// higher up. Everything Header pulls in (LogWorkoutButton, LogWorkoutForm)
// joins the client graph through this directive.
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { logout } from '@services/auth';
import { LogWorkoutButton } from '@components/log-workout-button';

export function Header({ showLogout = true }: { showLogout?: boolean }) {
  const router = useRouter();

  function handleLogout(): void {
    logout();
    router.push('/login');
  }

  return (
    <header className="flex items-center justify-between border-b border-zinc-200 px-6 py-3 dark:border-zinc-800">
      <Link href="/" className="text-lg font-semibold text-black dark:text-zinc-50">
        Workout Logging
      </Link>
      <div className="flex items-center gap-4">
        <LogWorkoutButton />
        {showLogout && (
          <button
            type="button"
            onClick={handleLogout}
            className="text-sm font-medium text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            Log out
          </button>
        )}
      </div>
    </header>
  );
}
