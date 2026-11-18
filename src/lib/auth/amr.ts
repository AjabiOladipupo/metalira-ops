/**
 * The `amr` methods Supabase Auth writes for a session opened from an emailed link: a one-time
 * code or token hash (`otp`), a magic link, a recovery link, the sign-up confirmation and an
 * invite. Only these prove the person holds the mailbox.
 */
export const EMAIL_LINK_METHODS = [
  "otp",
  "magiclink",
  "recovery",
  "email/signup",
  "invite",
] as const;

/**
 * True only when the access token's `amr` claim shows an email-link session: every method is
 * one of EMAIL_LINK_METHODS. Anything else (a password sign-in, an unknown method, a missing or
 * unreadable claim) is false, so callers fail closed (slice 1.13): only an email-link session may
 * choose the password that then counts. private.session_trusted applies the same list.
 */
export function signedInWithEmailLink(amr: unknown): boolean {
  if (!Array.isArray(amr) || amr.length === 0) return false;
  const methods = amr.map((entry) =>
    typeof entry === "object" && entry !== null ? (entry as { method?: unknown }).method : null,
  );
  return methods.every(
    (m) => typeof m === "string" && (EMAIL_LINK_METHODS as readonly string[]).includes(m),
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
  fromEmailLink: boolean;
  confirmedAt: string | null;
  passwordSetAt: unknown;
}): InvitePasswordStep {
  if (passwordTrusted(input.passwordSetAt, input.confirmedAt)) return "ready";
  return input.fromEmailLink ? "set_password" : "use_email_link";
}
