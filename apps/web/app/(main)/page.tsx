'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { hasSession } from '@services/auth';
import { useIsAuthenticated } from '@hooks/use-require-auth';

// No content of its own — just routes to /dashboard (authenticated) or
// /login (not), based on whether a token is in localStorage (T025).
export default function Home() {
  const router = useRouter();
  const authenticated = useIsAuthenticated();

  useEffect(() => {
    // hasSession() (not `authenticated`) so a refresh here doesn't flash
    // through /login before useSyncExternalStore re-syncs — see useRequireAuth.
    router.replace(hasSession() ? '/dashboard' : '/login');
  }, [authenticated, router]);

  return null;
}
