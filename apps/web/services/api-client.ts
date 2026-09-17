// Fetch wrapper for apps/api: attaches the Bearer access token, and on a 401
// transparently refreshes it (contracts/api.md POST /auth/refresh) and retries
// the request once. apps/web never talks to Postgres/Mongo/Redis/RabbitMQ
// directly — this is the one place all of that traffic funnels through.

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/api';
const TOKEN_STORAGE_KEY = 'workout-logging.tokens';

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`API request failed with status ${status}`);
  }
}

// In-memory cache backed by localStorage when available (browser), so every
// request doesn't need a JSON.parse round-trip — and so this module is
// testable outside a browser (no `window`) without changing its behavior.
//
// The cache is *observable*. It used to be write-only from the store's point of
// view: once `hydrated` was set nothing re-read storage, and nothing announced
// a change — so a sign-out in one tab left the other tab holding a token that
// no longer existed, and a failed refresh cleared the session with no one
// listening. Both are fixed here, by invalidating on the `storage` event and
// notifying subscribers on every mutation (docs/specs-archive/003 T044, T045).
let tokensCache: StoredTokens | null = null;
let hydrated = false;

const listeners = new Set<() => void>();

function notify(): void {
  // Iterate a copy: a listener may unsubscribe while React handles the change.
  for (const listener of [...listeners]) listener();
}

function hydrateFromStorage(): void {
  if (hydrated) return;
  hydrated = true;
  if (typeof window === 'undefined') return;
  const raw = window.localStorage.getItem(TOKEN_STORAGE_KEY);
  if (!raw) return;
  try {
    tokensCache = JSON.parse(raw) as StoredTokens;
  } catch {
    tokensCache = null;
  }
}

// One `storage` listener for the whole store, attached on first subscribe
// rather than at module load — this module is imported during the static
// export's prerender, where there is no window.
let watchingStorage = false;

function watchStorage(): void {
  if (watchingStorage || typeof window === 'undefined') return;
  watchingStorage = true;
  window.addEventListener('storage', (event) => {
    // `key === null` means another tab called localStorage.clear().
    if (event.key !== null && event.key !== TOKEN_STORAGE_KEY) return;
    // Drop the cache rather than trusting event.newValue: the next read
    // re-hydrates from storage, which is the one source of truth.
    tokensCache = null;
    hydrated = false;
    notify();
  });
}

/**
 * Subscribe to session changes — this tab's own sign-in/sign-out, and other
 * tabs' via the `storage` event. Returns an unsubscribe function.
 *
 * Shaped for `useSyncExternalStore`, so it must stay a stable reference.
 */
export function subscribeToSession(listener: () => void): () => void {
  watchStorage();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function loadTokens(): StoredTokens | null {
  hydrateFromStorage();
  return tokensCache;
}

export function saveTokens(tokens: StoredTokens): void {
  tokensCache = tokens;
  hydrated = true;
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(tokens));
  }
  notify();
}

export function clearTokens(): void {
  tokensCache = null;
  hydrated = true;
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
  notify();
}

async function requestRefresh(refreshToken: string): Promise<StoredTokens | null> {
  const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!response.ok) return null;
  return (await response.json()) as StoredTokens;
}

// Dedupes concurrent refresh attempts: refresh tokens rotate on use
// (research.md #6), so two parallel refresh calls with the same stored
// refresh_token would race — the second would fail because the first
// already revoked it. Everything piling up on a 401 awaits one shared call.
let refreshInFlight: Promise<StoredTokens | null> | null = null;

function refreshTokensOnce(refreshToken: string): Promise<StoredTokens | null> {
  refreshInFlight ??= requestRefresh(refreshToken).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

// For /auth/register and /auth/login specifically: no Bearer token to
// attach, and a 401 here means "wrong credentials", not "my token expired" —
// running it through apiFetch's refresh-and-retry logic would be semantically
// wrong (and wasteful) for that case, so this bypasses it entirely.
export async function apiFetchPublic(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, init);
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const tokens = loadTokens();
  const headers = new Headers(init.headers);
  if (tokens) {
    headers.set('authorization', `Bearer ${tokens.access_token}`);
  }

  let response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });

  if (response.status === 401 && tokens) {
    const refreshed = await refreshTokensOnce(tokens.refresh_token);
    if (!refreshed) {
      // The session is over: the access token was rejected and the refresh
      // token could not replace it. clearTokens() now notifies subscribers, so
      // useRequireAuth sees the session disappear and sends the user to
      // /login — this module stays out of routing, it just tells the truth
      // about the session and lets the hook that owns redirects react (T045).
      //
      // The 401 is still returned rather than thrown, so an in-flight caller
      // resolves normally instead of being left hanging mid-redirect.
      clearTokens();
      return response;
    }
    saveTokens(refreshed);
    headers.set('authorization', `Bearer ${refreshed.access_token}`);
    response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  }

  return response;
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    throw new ApiError(response.status, body);
  }
  return response.json() as Promise<T>;
}
