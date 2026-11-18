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

export type InvitePasswordStep =
  /** Accept as is: signed in with a password that predates nothing suspicious. */
  | "ready"
  /** Arrived through an email link: choose a password, then accept. */
  | "set_password"
  /**
   * Signed in with a password, but the address was confirmed since the invite was made and no
   * password was chosen from an email link after that: the password may be someone else's (an
   * account signed up through the Auth API before the invitee confirmed it). Use the email link.
   */
  | "use_email_link";

/**
 * What the join page asks for before accepting (slice 1.13). The database applies the same rule
 * (accept_membership_invite, SQLSTATE MLPW1).
 */
export function invitePasswordStep(input: {
  usedPassword: boolean;
  confirmedAt: string | null;
  passwordSetAt: unknown;
  invitedAt: string | null;
}): InvitePasswordStep {
  if (!input.usedPassword) return "set_password";
  const confirmed = input.confirmedAt ? Date.parse(input.confirmedAt) : NaN;
  const invited = input.invitedAt ? Date.parse(input.invitedAt) : NaN;
  if (Number.isNaN(confirmed) || Number.isNaN(invited) || confirmed < invited) return "ready";
  const set = typeof input.passwordSetAt === "string" ? Date.parse(input.passwordSetAt) : NaN;
  return !Number.isNaN(set) && set >= confirmed ? "ready" : "use_email_link";
}
