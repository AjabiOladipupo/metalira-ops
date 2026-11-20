import "server-only";

import { paymentTermsLabel } from "@/lib/company";
import {
  BILLING_FREQUENCIES,
  BILLING_FREQUENCY_LABELS,
  CONTRACT_TYPE_HINTS,
  CONTRACT_TYPE_LABELS,
  CONTRACT_TYPES,
} from "@/server/business/contract-schemas";
import { CLIENT_TERMS_DAYS } from "@/server/business/schemas";

/** Select options for the contract form, built on the server and handed to the client form. */
export const CONTRACT_TYPE_OPTIONS = CONTRACT_TYPES.map((value) => ({
  value,
  label: CONTRACT_TYPE_LABELS[value],
  hint: CONTRACT_TYPE_HINTS[value],
}));

export const BILLING_FREQUENCY_OPTIONS = BILLING_FREQUENCIES.map((value) => ({
  value,
  label: BILLING_FREQUENCY_LABELS[value],
}));

export const TERMS_OPTIONS = CLIENT_TERMS_DAYS.map((d) => ({
  value: String(d),
  label: paymentTermsLabel(d),
}));

/** "Client terms (30 days)", or the company's when the client has none. */
export function inheritedTermsLabel(clientDays: number | null, companyDays: number): string {
  return clientDays === null
    ? `Company terms (${paymentTermsLabel(companyDays)})`
    : `Client terms (${paymentTermsLabel(clientDays)})`;
}
