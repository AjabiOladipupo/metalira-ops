/**
 * What a company setup or settings action returns to `useActionState` when it does not redirect.
 * `status` mirrors the HTTP meaning: 403 when the caller's role may not change company settings,
 * 400 for input that fails validation, 500 when the save itself failed.
 */
export type CompanyFormState = {
  ok: boolean;
  status: 200 | 400 | 403 | 500;
  /** Short confirmation after a save that stays on the page ("Saved"). */
  message?: string;
  /** One sentence above the button, for problems that belong to no single field. */
  formError?: string;
  /** First message per field, keyed by the input's name. */
  fieldErrors?: Partial<Record<string, string>>;
  /** What the user typed, to refill the form after a refusal. */
  values?: Partial<Record<string, string>>;
} | null;
