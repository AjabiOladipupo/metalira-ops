import type { Kobo } from "@/lib/money";

/** One worker paid by a bank file. Lives only in server memory while the file is made. */
export interface BankFileItem {
  beneficiaryName: string;
  /** The decrypted account number (10 digits). Never logged, stored or returned. */
  accountNumber: string;
  bankCode: string;
  bankName: string;
  amountKobo: Kobo;
  /** "Salary Oct 2026 MLS-0001" */
  narration: string;
}

export interface BankFormat {
  /** Stored on payout_batches.bank_format; `^[a-z][a-z0-9-]{1,39}$`. */
  id: string;
  label: string;
  extension: "csv";
  contentType: "text/csv";
  render(items: readonly BankFileItem[]): Uint8Array;
}
