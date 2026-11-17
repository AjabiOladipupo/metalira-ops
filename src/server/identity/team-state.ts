/** What the team Server Actions return to `useActionState`. Types only, safe for the client. */

export type TeamActionState = {
  ok: boolean;
  status: 200 | 400 | 403 | 500;
  /** One sentence after a change ("Invite sent to ada@example.com."). */
  message?: string;
  /** One sentence above the button, for problems that belong to no single field. */
  formError?: string;
  /** First message per field, keyed by the input's name. */
  fieldErrors?: Partial<Record<string, string>>;
  /** What the user typed, to refill the form after a refusal. */
  values?: Partial<Record<string, string>>;
  /**
   * The invite link, shown once to the inviter only when the email did not go out (email not
   * set up on this deployment, or the send failed), so they can pass it on themselves.
   */
  link?: string;
} | null;

/** What the join page's forms (accept, sign up) return when they do not redirect. */
export type JoinActionState = {
  ok: false;
  formError?: string;
  fieldErrors?: Partial<Record<string, string>>;
  values?: Partial<Record<string, string>>;
} | null;
