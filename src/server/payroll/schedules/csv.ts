/**
 * CSV for statutory schedules (slice 5.6). Pure, so the unit tests read the exact bytes.
 *
 * - RFC 4180: cells with a comma, quote or line break are quoted, quotes doubled; rows end CRLF.
 * - Formula injection: a text cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage
 *   return gets a leading apostrophe, so a spreadsheet shows it as text and never runs it.
 *   Amounts are written by `nairaCell` and are never negative here.
 * - A UTF-8 byte order mark first, so spreadsheet programs read names with accents correctly.
 * - Kobo to naira with 2 decimals in integer maths (`koboToMajorString`), no grouping, no ₦.
 */
import { koboToMajorString, type Kobo } from "@/lib/money";

const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** A text cell, safe from formula injection and quoted when it must be. */
export function csvCell(value: string): string {
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** An amount in naira with 2 decimals: 12000000n gives "120000.00". */
export function nairaCell(kobo: Kobo): string {
  if (kobo < 0n) throw new RangeError("Schedule amounts are never negative.");
  return koboToMajorString(kobo);
}

/** Cells already made by `csvCell` or `nairaCell`, one array per row. */
export type CsvRow = readonly string[];

const BOM = "﻿";

/** The file: a byte order mark, then each row joined by commas and ended by CRLF. */
export function toCsv(rows: readonly CsvRow[]): Uint8Array {
  const text = BOM + rows.map((row) => `${row.join(",")}\r\n`).join("");
  return new TextEncoder().encode(text);
}
