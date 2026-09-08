// Imported by app/(main)/layout.tsx and app/(auth)/layout.tsx, which are
// Server Components — a root layout exporting `metadata` cannot be a Client
// Component, so the client boundary has to be declared here rather than
// higher up. Everything Header pulls in (LogWorkoutButton, LogWorkoutForm)
// joins the client graph through this directive.
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { LogWorkoutButton } from '@components/log-workout-button';
import { useIsAuthenticated } from '@hooks/use-require-auth';
import { logout } from '@services/auth';

// No `showLogout` prop any more. It used to be the (auth) layout's way of
// hiding sign-out, which left the control showing wherever nobody remembered
// to pass it — notably on "/", which lives in the (main) group and so rendered
// a bare <Header />: a signed-out visitor was offered "Log out" for as long as
// the redirect to /login took (FR-020, SC-006).
//
// Asking the session directly cannot be forgotten, and matches LogWorkoutButton,
// which already gates itself the same way.
export function Header() {
  const router = useRouter();
  const authenticated = useIsAuthenticated();

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
        {authenticated && (
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
