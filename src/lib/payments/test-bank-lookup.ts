/**
 * The test resolver: a deterministic stand-in for the bank network, for local development, CI
 * and previews without provider keys (slice 2.3b). Never used in production
 * (src/server/billing/bank-lookup.ts refuses there), and every name it gives is labelled
 * "Test lookup" on screen.
 *
 * The answer depends on the account number's last digit, so tests and people trying a preview
 * can choose the outcome:
 *
 *   0-6  the expected name, as a bank would print it (surname first, upper case)  -> match
 *   7    a close name (surname and first initial; the company's first word cut short) -> near
 *   8    someone else's name (OKONKWO CHIDINMA BLESSING)                         -> no match
 *   9    no such account
 *
 * and "0000000000" always times out (a provider that didn't answer).
 */
import {
  validResolveInput,
  type BankAccountResolver,
  type ResolveBankAccountInput,
  type ResolveBankAccountResult,
} from "./bank-lookup";

export const TEST_LOOKUP_OTHER_PERSON = "OKONKWO CHIDINMA BLESSING";

const upper = (text: string) => text.trim().replace(/\s+/g, " ").toUpperCase();

function testName(input: ResolveBankAccountInput, digit: number): string {
  const expected = input.expectedNames;
  if (digit === 8 || !expected) return TEST_LOOKUP_OTHER_PERSON;
  if (expected.kind === "person") {
    const first = upper(expected.firstName);
    const last = upper(expected.lastName);
    return digit === 7 ? `${last} ${first.charAt(0)}` : `${last} ${first}`;
  }
  const name = expected.names.find((n) => n.trim()) ?? "";
  if (!name) return TEST_LOOKUP_OTHER_PERSON;
  const printed = upper(name).replace(/\bLTD\b\.?/g, "LIMITED");
  if (digit === 7) {
    // The first word cut short by a letter, as a bank record sometimes has it.
    const [first = "", ...rest] = printed.split(" ");
    return [first.length > 4 ? first.slice(0, -1) : `${first}X`, ...rest].join(" ");
  }
  return printed;
}

export function createTestBankAccountResolver(): BankAccountResolver {
  return {
    source: "test",
    async resolveBankAccount(input): Promise<ResolveBankAccountResult> {
      if (!validResolveInput(input)) return { ok: false, error: "not_found" };
      if (input.accountNumber === "0000000000") return { ok: false, error: "timeout" };
      const digit = Number(input.accountNumber.at(-1));
      if (digit === 9) return { ok: false, error: "not_found" };
      return { ok: true, accountName: testName(input, digit), source: "test" };
    },
  };
}
