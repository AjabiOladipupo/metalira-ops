import { expect, type Locator } from "@playwright/test";

/**
 * Bank details in a form (slice 2.3b): pick the bank from the searchable list, type the number,
 * and wait for the bank's account name. The app under test runs the deterministic test resolver
 * (no provider keys): the number's last digit picks the answer.
 *
 *   0-6 match · 7 close match · 8 someone else's name (no match) · 9 no such account
 */
export const MATCH_ENDING = "1";
export const NEAR_ENDING = "7";
export const NO_MATCH_ENDING = "8";

export async function pickBank(scope: Locator, search: string, bankName: string, label = "Bank") {
  const input = scope.getByRole("combobox", { name: label, exact: true });
  await input.click();
  await input.fill(search);
  await scope.getByRole("option").filter({ hasText: bankName }).first().click();
  await expect(input).toHaveValue(bankName);
}

/** Picks the bank, types the number and waits for the bank's name; returns the result box. */
export async function enterBankAccount(
  scope: Locator,
  {
    search,
    bankName,
    number,
    prefix = "",
  }: { search: string; bankName: string; number: string; prefix?: string },
): Promise<Locator> {
  await pickBank(scope, search, bankName, prefix ? `${prefix}bank` : "Bank");
  await scope
    .getByLabel(prefix ? `${prefix}account number` : "Account number", { exact: true })
    .fill(number);
  const result = scope.getByTestId("bank-lookup-result");
  await expect(result).toBeVisible({ timeout: 15_000 });
  await expect(result.getByTestId("test-lookup")).toBeVisible();
  return result;
}
