import "server-only";

import type { Kobo } from "@/lib/money";

/**
 * CSV helpers for bank files (slice 5.4). Pure, integer maths only.
 */

/**
 * Naira with exactly two decimals from kobo, by integer division: 12000000n gives "120000.00",
 * 5n gives "0.05". A bank file pays only positive amounts.
 */
export function nairaAmount(kobo: Kobo): string {
  if (typeof kobo !== "bigint" || kobo <= 0n) {
    throw new RangeError("A bank file pays only amounts above ₦0.");
  }
  const naira = kobo / 100n;
  const fraction = kobo % 100n;
  return `${naira.toString()}.${fraction.toString().padStart(2, "0")}`;
}

/**
 * One CSV cell. A cell a spreadsheet would read as a formula (it starts with `=`, `+`, `-`, `@`,
 * a tab or a carriage return) gets a leading apostrophe, so opening the file never runs it.
 * Cells holding a comma, a quote or a line break are quoted, with quotes doubled.
 */
export function csvCell(value: string): string {
  let cell = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(cell)) cell = `"${cell.replace(/"/g, '""')}"`;
  return cell;
}

/** Rows joined with CRLF, ending with one, as UTF-8 bytes (no byte-order mark). */
export function csvBytes(rows: readonly (readonly string[])[]): Uint8Array {
  const text = rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  return new TextEncoder().encode(text);
}
