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
 * it they get 50 per window, and lockouts inside a window that reached the cap don't count
 * towards a hold. One network address gets at most IP_WRONG_PIN_CAP of the 50.
 * The cost: a sustained attack can keep new sign-ins for one company closed 15 minutes at a
 * time. Nobody already signed in is affected, nobody is locked out for longer, each window that
 * hits the cap is in the audit log (worker_auth.company_throttled), and every owner and HR user gets one
 * email per window. Owner confirmed 50 per 15 minutes on 18 Nov 2026, to review after pilots.
 */
export const COMPANY_WRONG_PIN_CAP = 50;
export const COMPANY_WINDOW_MINUTES = 15;

/**
 * Wrong PINs per network address per 15 minutes. Well below the company cap, so one address
 * can't use up a company's allowance (or push its workers into holds) on its own: at most 3
 * workers locked per window per address, against 15 a single worker could need to lock 3 times.
 */
export const IP_WRONG_PIN_CAP = 15;

/**
 * All tries per network address per 15 minutes (slice 1.9). Successes give nothing back, so a
 * valid login can't be used to reset it.
 */
export const IP_ATTEMPT_LIMIT = 100;

export interface SignInCredential {
  /** Null for a line manager, who sees only the lock state. */
  pinSetAt: string | null;
  lastSignInAt: string | null;
  /** Null for a line manager. */
  failedAttempts: number | null;
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
  return { kind: "open", failedAttempts: cred.lockedUntil ? 0 : (cred.failedAttempts ?? 0) };
}
