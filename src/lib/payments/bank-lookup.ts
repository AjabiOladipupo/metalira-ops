/**
 * Account name lookup ("name enquiry") from the bank network: given a bank code and a 10-digit
 * account number, the name the bank holds for that account (slice 2.3b). Provider-neutral; the
 * adapter lives next to this file and server code reaches it only through
 * src/server/billing/bank-lookup.ts.
 *
 * Metalira looks names up with its own provider account, for its customers' forms. No money
 * moves and no customer credentials are involved (rule 6). The answer is personal data: never
 * log the account number or the returned name, and never cache an answer for another user.
 */

export interface ResolveBankAccountInput {
  bankCode: string;
  /** 10 digits. */
  accountNumber: string;
  /**
   * The names the caller expects. Used ONLY by the test resolver, to give a predictable match,
   * near or no-match answer in tests and previews without keys; a real provider never sees it.
   */
  expectedNames?:
    | { kind: "company"; names: readonly string[] }
    | {
        kind: "person";
        firstName: string;
        lastName: string;
      };
}

export type ResolveBankAccountError =
  /** The bank has no such account. */
  | "not_found"
  /** The provider doesn't know the bank code. */
  | "invalid_bank"
  /** The provider or the destination bank didn't answer in time. */
  | "timeout"
  /** The provider failed or refused (outage, auth, limits). Retry later. */
  | "unavailable"
  /** No provider keys here, and test answers aren't allowed (production). */
  | "not_configured";

/**
 * Where an answer came from: the provider's live service, its sandbox (previews), or the test
 * resolver. Only `bank` is a real bank's answer.
 */
export type LookupSource = "bank" | "sandbox" | "test";

export type ResolveBankAccountResult =
  | { ok: true; accountName: string; source: LookupSource }
  | { ok: false; error: ResolveBankAccountError };

export interface BankAccountResolver {
  /** "bank" for the provider's live service, "sandbox" for its sandbox, "test" for the test resolver. */
  readonly source: LookupSource;
  resolveBankAccount(input: ResolveBankAccountInput): Promise<ResolveBankAccountResult>;
}

/** Validates the input shape every resolver shares. */
export function validResolveInput(input: ResolveBankAccountInput): boolean {
  return /^\d{3,6}$/.test(input.bankCode) && /^\d{10}$/.test(input.accountNumber);
}
