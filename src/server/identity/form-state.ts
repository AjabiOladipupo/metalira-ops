/**
 * What an identity form action returns to `useActionState` when it does not redirect.
 * Passwords are never echoed back in `values`.
 */
export type FormState = {
  ok: false;
  /** One sentence above the button, for problems that belong to no single field. */
  formError?: string;
  /** First message per field, keyed by the input's name. */
  fieldErrors?: Partial<Record<string, string>>;
  /** What the user typed, to refill the form. */
  values?: Partial<Record<string, string>>;
} | null;
