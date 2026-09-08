// HTTP operations against apps/api's /auth routes, plus ownership of the
// session they establish. Follows the extension contract documented at the top
// of services/workouts.ts, with one deliberate difference noted below.
//
// Not here: token *refresh*. That lives inside api-client's apiFetch, where a
// 401 transparently rotates the token and retries. It is a transport concern
// rather than something the UI invokes, and moving it here would make
// api-client import this module while this module imports api-client.

import {
  apiFetchPublic,
  clearTokens,
  loadTokens,
  saveTokens,
  subscribeToSession,
  type StoredTokens,
} from './api-client';

/**
 * Why an attempt did not establish a session. Domain outcomes, not HTTP —
 * mapping status codes is this module's job, so the form can decide what to
 * *say* without knowing what the server *sent* (workouts.ts contract, rule 4).
 */
export type AuthFailure =
  /** Register: that email already has an account. */
  | 'email_taken'
  /** Log in: wrong email or password. */
  | 'invalid_credentials'
  /** The server rejected the email or password as malformed. */
  | 'invalid_input'
  /** The request never reached the server. */
  | 'unavailable'
  | 'unknown';

export type AuthResult = { ok: true } | { ok: false; failure: AuthFailure };

export interface Credentials {
  email: string;
  password: string;
}

// Unlike the rest of the services, these do not throw: for a sign-in form,
// "wrong password" is an ordinary outcome to render, not an exception. Same
// judgement as getWorkout returning null for 404 — the caller can act on the
// result either way, so it is a value.
async function authenticate(path: string, credentials: Credentials, rejectionFailure: AuthFailure): Promise<AuthResult> {
  let response: Response;
  try {
    response = await apiFetchPublic(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(credentials),
    });
  } catch {
    // fetch rejects only when the request never completed — offline, DNS, CORS.
    return { ok: false, failure: 'unavailable' };
  }

  if (!response.ok) {
    // 409 on register (email exists), 401 on login (bad credentials) — each
    // route has exactly one "understood you, and no" status.
    if (response.status === 409 || response.status === 401) return { ok: false, failure: rejectionFailure };
    if (response.status === 400) return { ok: false, failure: 'invalid_input' };
    return { ok: false, failure: 'unknown' };
  }

  // Establishing the session is what logging in *is*, so this module does it
  // rather than handing tokens back and trusting every caller to store them.
  const tokens = (await response.json()) as StoredTokens;
  saveTokens(tokens);
  return { ok: true };
}

/** POST /auth/register — on success the new account is signed in. */
export async function register(credentials: Credentials): Promise<AuthResult> {
  return authenticate('/auth/register', credentials, 'email_taken');
}

/** POST /auth/login. */
export async function login(credentials: Credentials): Promise<AuthResult> {
  return authenticate('/auth/login', credentials, 'invalid_credentials');
}

/**
 * Discard the stored session.
 *
 * No request: refresh tokens rotate on use and the server has no
 * revoke-on-logout endpoint, so signing out is purely local. Here rather than
 * inline in the header so there is one place to change when the token store
 * grows change notification (specs/003 T044).
 */
export function logout(): void {
  clearTokens();
}

/**
 * Whether a session is stored right now.
 *
 * Read this synchronously wherever a redirect decision is made — it reflects
 * storage at the moment of the call, unlike a subscribed value, which serves
 * its server snapshot for one tick after hydration and would bounce a page
 * refresh through /login.
 *
 * Says nothing about whether the token is still *accepted*: an expired token
 * is discovered on the next request, where apiFetch tries to refresh it.
 */
export function hasSession(): boolean {
  return loadTokens() !== null;
}

/**
 * Subscribe to session changes, for `useSyncExternalStore`.
 *
 * Fires on this tab's sign-in and sign-out, on another tab's (via the
 * `storage` event), and when a failed token refresh ends the session
 * mid-request — that last one is what turns an expired session into a
 * redirect instead of a retry button that can only keep failing.
 *
 * Re-exported unchanged so callers depend on the session module rather than
 * the transport underneath it; it must stay a stable reference.
 */
export { subscribeToSession };
