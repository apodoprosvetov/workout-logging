'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useIsAuthenticated } from '../lib/use-require-auth';

// No content of its own — just routes to /dashboard (authenticated) or
// /login (not), based on whether a token is in localStorage (T025).
export default function Home() {
  const router = useRouter();
  const authenticated = useIsAuthenticated();

  useEffect(() => {
    router.replace(authenticated ? '/dashboard' : '/login');
  }, [authenticated, router]);

  return null;
}
