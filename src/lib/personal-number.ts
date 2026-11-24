/**
 * Personal numbers in free text (CLAUDE.md rule 9: NIN, BVN, account numbers, RSA PIN), as the
 * database's private.has_personal_number decides (migration 20261122190000): 10 or more digits in
 * a row once spaces and dashes are ignored, or PEN followed by 12 digits. Pure.
 */
export function hasPersonalNumber(text: string): boolean {
  const squeezed = text.replace(/[\s-]/g, "");
  return /[0-9]{10}/.test(squeezed) || /PEN[0-9]{12}/i.test(squeezed);
}

export const PERSONAL_NUMBER_MESSAGE =
  "Leave personal numbers out (10 or more digits, or an RSA PIN)";
