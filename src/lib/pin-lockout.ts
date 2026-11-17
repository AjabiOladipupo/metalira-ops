/**
 * PIN sign-in limits (owner decisions 6 and 18) and the sign-in status a manager sees on a
 * worker's page. The database enforces the limits (private.worker_sign_in_begin_impl and
 * worker_sign_in_finish_impl, migration 20261117180000); these constants are the same numbers,
 * kept in step by tests/unit/identity/pin-lockout.test.ts, for copy and display only.
 *
 * Isomorphic and pure: no secrets, safe in client components.
 */

/** Wrong PINs in a row that lock sign-in. */
export const PIN_MAX_ATTEMPTS = 5;
/** How long a lock lasts. */
export const PIN_LOCK_MINUTES = 15;
/** The lockout within PIN_HOLD_WINDOW_HOURS that holds sign-in until a new PIN is set. */
export const PIN_HOLD_AFTER_LOCKOUTS = 3;
export const PIN_HOLD_WINDOW_HOURS = 24;

/**
 * Wrong PINs per company code per COMPANY_WINDOW_MINUTES. At the cap, new sign-ins for that
 * company are refused before any PIN is checked, and the refusals count against no worker.
 *
 * Why 50: workers stay signed in on their phones, so sign-ins (and typos) are rare. Even a mass
 * sign-in of a few hundred workers at shift change makes well under 50 wrong tries, so honest
 * use should never reach it. Without it, someone spraying guesses across a 500-person company
 * gets 5 tries per staff ID, 2,500 per window, and locks (then holds) the whole workforce; with
 * it they get 50 per window, and can push at most about 3 workers per window towards a hold.
 * The cost: a sustained attack can keep new sign-ins for one company closed 15 minutes at a
 * time. Nobody already signed in is affected, nobody is locked out for longer, and each window
 * that hits the cap is in the audit log (worker_auth.company_throttled).
 */
export const COMPANY_WRONG_PIN_CAP = 50;
export const COMPANY_WINDOW_MINUTES = 15;

/** Network address cap (slice 1.9), per 15 minutes. */
export const IP_ATTEMPT_LIMIT = 100;

export interface SignInCredential {
  pinSetAt: string;
  lastSignInAt: string | null;
  failedAttempts: number;
  lockedUntil: string | null;
  heldAt: string | null;
}

export type SignInState =
  | { kind: "no_login" }
  | { kind: "held"; since: string }
  | { kind: "locked"; until: string }
  | { kind: "open"; failedAttempts: number };

/** The sign-in status of a worker's login at `now`. */
export function signInState(cred: SignInCredential | null, now: Date = new Date()): SignInState {
  if (!cred) return { kind: "no_login" };
  if (cred.heldAt) return { kind: "held", since: cred.heldAt };
  if (cred.lockedUntil && Date.parse(cred.lockedUntil) > now.getTime()) {
    return { kind: "locked", until: cred.lockedUntil };
  }
  // A lock that has run out resets the count at the next try.
  return { kind: "open", failedAttempts: cred.lockedUntil ? 0 : cred.failedAttempts };
}
