/** What the self-onboarding Server Actions return to `useActionState`. Types only, client safe. */

export type OnboardingActionState = {
  ok: boolean;
  /** One sentence after a change ("Invite sent to ada@example.com as Guard."). */
  message?: string;
  /** One sentence above the button, for problems that belong to no single field. */
  formError?: string;
  /** First message per field, keyed by the input's name. */
  fieldErrors?: Partial<Record<string, string>>;
  /** What was typed, to refill the form after a refusal. Never personal numbers. */
  values?: Partial<Record<string, string>>;
  /**
   * The link, shown once to the inviter only when email is deliberately off here (development
   * and previews without a Resend key), so they can pass it on themselves.
   */
  link?: string;
} | null;
