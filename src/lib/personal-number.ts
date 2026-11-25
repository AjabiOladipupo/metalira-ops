/**
 * Personal numbers in free text (CLAUDE.md rule 9: NIN, BVN, account numbers, RSA PIN), as the
 * database's private.has_personal_number decides (migrations 20261122190000 and 20261122250000): 10 or more digits in
 * a row once every character but letters and digits is ignored (security review L3, slice 5.9c:
 * dots, slashes and brackets too), or PEN followed by 12 digits. Pure.
 */
export function hasPersonalNumber(text: string): boolean {
  const squeezed = text.replace(/[^\p{L}\p{N}]/gu, "");
  return /[0-9]{10}/.test(squeezed) || /PEN[0-9]{12}/i.test(squeezed);
}

export const PERSONAL_NUMBER_MESSAGE =
  "Leave personal numbers out (10 or more digits, or an RSA PIN)";
