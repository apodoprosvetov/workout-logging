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
async function authenticate(
  path: string,
  credentials: Credentials,
  rejectionFailure: AuthFailure,
): Promise<AuthResult> {
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
    if (response.status === 409 || response.status === 401)
      return { ok: false, failure: rejectionFailure };
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
 * Discard the stored session. No request — refresh tokens rotate on use and the
 * server has no revoke endpoint, so signing out is purely local.
 */
export function logout(): void {
  clearTokens();
}

/**
 * Whether a session is stored right now — read synchronously wherever a
 * redirect is decided. A subscribed value serves its server snapshot for one
 * tick after hydration and would bounce a refresh through /login.
 *
 * Says nothing about the token still being accepted; apiFetch finds that out.
 */
export function hasSession(): boolean {
  return loadTokens() !== null;
}

/**
 * Session changes, for `useSyncExternalStore`: this tab's sign-in/out, another
 * tab's via `storage`, and a failed refresh ending the session mid-request —
 * the last is what turns an expired session into a redirect rather than a retry
 * button that can only keep failing.
 */
export { subscribeToSession };
