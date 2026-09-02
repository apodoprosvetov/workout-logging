'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { loadTokens } from './api-client';

function hasStoredSession(): boolean {
  return loadTokens() !== null;
}

// localStorage (T025's token store) is external mutable state, not React
// state — useSyncExternalStore is the documented primitive for this
// (react-hooks/set-state-in-effect's own diagnostic recommends it over
// useState+useEffect for "force update / external sync"). Reacts to the
// native `storage` event, which covers cross-tab logout; same-tab logout
// (dashboard's handleLogout) redirects explicitly rather than relying on this.
function subscribe(callback: () => void): () => void {
  window.addEventListener('storage', callback);
  return () => window.removeEventListener('storage', callback);
}

function getSnapshot(): boolean {
  return hasStoredSession();
}

function getServerSnapshot(): boolean {
  return false; // no session on the server; client re-checks after hydration
}

// Shared by useRequireAuth (redirect-to-login-if-absent) and the root page
// (redirect-to-dashboard-or-login-either-way) — same external-store subscription.
export function useIsAuthenticated(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
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
    // with localStorage readable, so loadTokens() is the source of truth.
    // `authenticated` stays in the deps so a cross-tab logout re-runs this.
    if (!hasStoredSession()) {
      router.replace('/login');
    }
  }, [authenticated, router]);

  return authenticated;
}
