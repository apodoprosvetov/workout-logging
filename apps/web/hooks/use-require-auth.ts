'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';

import { hasSession, subscribeToSession } from '@services/auth';

// The stored session is external mutable state, not React state —
// useSyncExternalStore is the documented primitive for it
// (react-hooks/set-state-in-effect's own diagnostic recommends it over
// useState+useEffect for "force update / external sync").
//
// The subscription comes from the session store itself rather than a raw
// `storage` listener here. A `storage` listener alone was not enough and was
// in fact broken: it fires only for *other* tabs, and the store's snapshot was
// memoized anyway, so neither a cross-tab sign-out nor an expired session in
// this tab ever reached React. The store now invalidates and announces both
// (T044/T045).

function getSnapshot(): boolean {
  return hasSession();
}

function getServerSnapshot(): boolean {
  return false; // no session on the server; client re-checks after hydration
}

// Shared by useRequireAuth (redirect-to-login-if-absent) and the root page
// (redirect-to-dashboard-or-login-either-way) — same external-store subscription.
export function useIsAuthenticated(): boolean {
  return useSyncExternalStore(subscribeToSession, getSnapshot, getServerSnapshot);
}

export function useRequireAuth(): boolean {
  const router = useRouter();
  const authenticated = useIsAuthenticated();

  useEffect(() => {
    // Read localStorage directly, not `authenticated`: during hydration
    // useSyncExternalStore serves getServerSnapshot() === false (no session on
    // the server) and only re-syncs to the real client snapshot a tick later —
    // keying the redirect off `authenticated` bounces every page refresh to
    // /login before that sync lands. Here in the effect we're on the client
    // with localStorage readable, so hasSession() is the source of truth.
    // `authenticated` stays in the deps so a session ending elsewhere — another
    // tab signing out, or a refresh failing mid-request — re-runs this.
    if (!hasSession()) {
      router.replace('/login');
    }
  }, [authenticated, router]);

  return authenticated;
}
