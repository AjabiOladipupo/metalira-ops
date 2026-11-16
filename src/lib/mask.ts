/**
 * Masked display of personal data (CLAUDE.md rule 9). Pure and browser-safe: no decryption
 * happens here. Each function accepts either the full value (for a worker's own entry, or a
 * server that has just decrypted it) or only its last four digits (the `_last4` columns that
 * lists read), and returns the same masked text either way.
 *
 * Formats follow the prototypes: `••••7712`, `PEN••••4421`, `0803 ••• 4410`.
 * Every function returns "" when there is nothing to show; the screen decides what to say.
 */

export const MASK = "•";

type Maybe = string | null | undefined;

function digits(value: Maybe): string {
  return (value ?? "").replace(/\D/g, "");
}

/** The last four digits of a value, or null when it has fewer than four digits. */
export function last4(value: Maybe): string | null {
  const d = digits(value);
  return d.length >= 4 ? d.slice(-4) : null;
}

function tail(value: Maybe): string {
  return last4(value) ?? "";
}

/** Bank account number (NUBAN): `••••7712`. */
export function maskAccount(value: Maybe): string {
  if (!digits(value)) return "";
  return `${MASK.repeat(4)}${tail(value)}`;
}

/** RSA PIN: `PEN••••4421`. */
export function maskRsaPin(value: Maybe): string {
  if (!digits(value)) return "";
  return `PEN${MASK.repeat(4)}${tail(value)}`;
}

/**
 * Nigerian phone number: `0803 ••• 4410`. `+234…` and `234…` forms are shown in the local
 * `0…` form. Anything that is not an 11-digit local number keeps only its last four digits.
 */
export function maskPhone(value: Maybe): string {
  let d = digits(value);
  if (!d) return "";
  if (d.length === 13 && d.startsWith("234")) d = `0${d.slice(3)}`;
  if (d.length === 11 && d.startsWith("0")) {
    return `${d.slice(0, 4)} ${MASK.repeat(3)} ${d.slice(-4)}`;
  }
  return `${MASK.repeat(3)} ${tail(d)}`.trimEnd();
}

/** NIN: `•••••••8901`. Screens normally show `ninStatus` instead (owner decision 8). */
export function maskNin(value: Maybe): string {
  if (!digits(value)) return "";
  return `${MASK.repeat(7)}${tail(value)}`;
}

/** True when a NIN is exactly 11 digits. A format check only: it never means "verified". */
export function isNinFormat(value: Maybe): boolean {
  return /^\d{11}$/.test((value ?? "").trim());
}

/** What screens show for a NIN: "On file" or "Missing", never "Verified" (owner decision 8). */
export function ninStatus(onFile: boolean): "On file" | "Missing" {
  return onFile ? "On file" : "Missing";
}

/** The personal data fields that are encrypted at rest and masked for most roles. */
export const PII_FIELDS = ["nin", "bank_account", "rsa_pin"] as const;
export type PiiField = (typeof PII_FIELDS)[number];

/** The masked form of one field, from its full value or its last four digits. */
export function maskPii(field: PiiField, value: Maybe): string {
  switch (field) {
    case "nin":
      return maskNin(value);
    case "bank_account":
      return maskAccount(value);
    case "rsa_pin":
      return maskRsaPin(value);
  }
}
