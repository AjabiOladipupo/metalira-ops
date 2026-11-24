import "server-only";

import type { Kobo } from "@/lib/money";
import { csvCell } from "@/server/people/import/csv";

/**
 * Cells are escaped by the shared `csvCell` (src/server/README.md "CSV downloads"): a cell starting
 * with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading apostrophe so a spreadsheet
 * never runs it; commas, quotes and line breaks are quoted.
 */
export { csvCell };

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
 * Rows joined with CRLF, ending with one, as UTF-8 bytes. Unlike `formatCsv` there is no byte-order
 * mark: bank upload portals read plain UTF-8 and some refuse a BOM.
 */
export function csvBytes(rows: readonly (readonly string[])[]): Uint8Array {
  const text = rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  return new TextEncoder().encode(text);
}
