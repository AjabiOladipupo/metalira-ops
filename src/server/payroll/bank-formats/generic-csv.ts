import "server-only";

import { FORMULA_START } from "@/lib/payroll/payout";

import { csvBytes, nairaAmount } from "./csv";
import type { BankFileItem, BankFormat } from "./types";

/**
 * The generic bulk-payment CSV (slice 5.4, decision 12): one header row, then one row per worker
 * paid, in the batch's order. Each pilot's bank template becomes another format beside this one.
 */
export const GENERIC_CSV_HEADER = [
  "Beneficiary name",
  "Account number",
  "Bank code",
  "Bank name",
  "Amount",
  "Narration",
] as const;

export const genericCsv: BankFormat = {
  id: "generic-csv",
  label: "Generic CSV (any bank)",
  extension: "csv",
  contentType: "text/csv",
  render(items: readonly BankFileItem[]): Uint8Array {
    // Payee names that start like a formula are refused before the file is made (security review
    // L4); every cell is still escaped by csvCell as the last defence.
    if (
      items.some((i) => FORMULA_START.test(i.beneficiaryName) || FORMULA_START.test(i.bankName))
    ) {
      throw new RangeError("A payee name starts with =, +, - or @.");
    }
    return csvBytes([
      GENERIC_CSV_HEADER,
      ...items.map((item) => [
        item.beneficiaryName,
        item.accountNumber,
        item.bankCode,
        item.bankName,
        nairaAmount(item.amountKobo),
        item.narration,
      ]),
    ]);
  },
};
