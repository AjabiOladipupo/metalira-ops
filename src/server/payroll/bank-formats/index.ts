import "server-only";

import { genericCsv } from "./generic-csv";
import type { BankFormat } from "./types";

export type { BankFileItem, BankFormat } from "./types";

/**
 * The bank file formats (slice 5.4, docs/PHASE_5.md decision 12): the generic CSV first; each
 * pilot's bulk-payment template is added here as one more format, with a fixture test of its bytes.
 */
export const BANK_FORMATS: readonly BankFormat[] = [genericCsv];

export const BANK_FORMAT_IDS = ["generic-csv"] as const satisfies readonly string[];
export type BankFormatId = (typeof BANK_FORMAT_IDS)[number];

export function bankFormat(id: string): BankFormat | null {
  return BANK_FORMATS.find((f) => f.id === id) ?? null;
}

/** The formats for the screen's picker. */
export function bankFormatOptions(): { value: string; label: string }[] {
  return BANK_FORMATS.map((f) => ({ value: f.id, label: f.label }));
}

const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** "Salary Oct 2026 MLS-0001", from the run's period end (its month) and the staff ID. */
export function salaryNarration(periodEnd: string, staffId: string): string {
  const [year, month] = periodEnd.split("-").map(Number);
  return `Salary ${SHORT_MONTHS[(month ?? 1) - 1]} ${year} ${staffId}`.trim();
}
