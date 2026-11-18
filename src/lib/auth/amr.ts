/**
 * How a session was signed in, from the access token's `amr` claim (Supabase Auth writes one
 * entry per method, e.g. `{ method: "password" }` or `{ method: "otp" }` for an email link).
 * Pure, for the join page (slice 1.13): someone who arrived through an email link sets their own
 * password before accepting an invite, so a password chosen by whoever held the link (or anyone
 * who signed the address up through the Auth API) never survives.
 */
export function signedInWithPassword(amr: unknown): boolean {
  return (
    Array.isArray(amr) &&
    amr.some(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { method?: unknown }).method === "password",
    )
  );
}

/** app_metadata key the server sets (secret key) when a password was chosen after an email link. */
export const PASSWORD_SET_AT_KEY = "password_set_at";

/**
 * True when the account's password was chosen after its address was confirmed
 * (`password_set_at` at or after `email_confirmed_at`). Only then is a password sign-in
 * trusted: otherwise the password may be one somebody else chose by signing the address up
 * before its owner confirmed it. The database applies the same rule (private.password_trusted).
 */
export function passwordTrusted(
  passwordSetAt: unknown,
  confirmedAt: string | null | undefined,
): boolean {
  const confirmed = confirmedAt ? Date.parse(confirmedAt) : NaN;
  const set = typeof passwordSetAt === "string" ? Date.parse(passwordSetAt) : NaN;
  return !Number.isNaN(confirmed) && !Number.isNaN(set) && set >= confirmed;
}

export type InvitePasswordStep =
  /** Accept as is: the account's password is trusted. */
  | "ready"
  /** Arrived through an email link and no trusted password yet: choose one, then accept. */
  | "set_password"
  /** Signed in with a password that is not trusted: use an email link and choose a new one. */
  | "use_email_link";

/**
 * What the join page asks for before accepting (slice 1.13). The database applies the same rule
 * (accept_membership_invite, SQLSTATE MLPW1).
 */
export function invitePasswordStep(input: {
  usedPassword: boolean;
  confirmedAt: string | null;
  passwordSetAt: unknown;
}): InvitePasswordStep {
  if (passwordTrusted(input.passwordSetAt, input.confirmedAt)) return "ready";
  return input.usedPassword ? "use_email_link" : "set_password";
}
