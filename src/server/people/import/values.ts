import { parseNairaToKobo, type Kobo } from "@/lib/money";

import type { EmploymentType } from "./types";

/**
 * Cell parsers for the people import. Pure functions over strings: no `Number`, no
 * `parseFloat`, no floats anywhere (CLAUDE.md rule 1). Each returns `null` for a blank cell
 * and a tagged error for a value it can't accept.
 */

export type Parsed<T> = { ok: true; value: T } | { ok: false };

/**
 * Naira amounts from a file: `105000`, `105,000` (correctly grouped) or `105000.50` (one or two
 * decimals). Nothing else: no ₦ sign, no minus, no spaces inside, no exponent. The digits are
 * handed to `parseNairaToKobo`, which does the exact bigint conversion.
 */
const IMPORT_NAIRA = /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/;

export function parseImportNaira(raw: string): Parsed<Kobo> {
  const value = raw.trim();
  if (!IMPORT_NAIRA.test(value)) return { ok: false };
  return { ok: true, value: parseNairaToKobo(value) };
}

const MOBILE = /^0(?:70|80|81|90|91)\d{8}$/;

/**
 * A Nigerian mobile number in local 11-digit form (`08031234567`). Accepts spaces, dashes,
 * dots and brackets, a +234 or 234 prefix, and a 10-digit number whose leading zero a
 * spreadsheet dropped.
 */
export function parseNigerianMobile(raw: string): Parsed<string> {
  let digits = raw.trim().replace(/[\s\-().]/g, "");
  if (digits.startsWith("+234")) digits = `0${digits.slice(4)}`;
  else if (/^234\d{10}$/.test(digits)) digits = `0${digits.slice(3)}`;
  else if (/^[789][01]\d{8}$/.test(digits)) digits = `0${digits}`;
  return MOBILE.test(digits) ? { ok: true, value: digits } : { ok: false };
}

/** `0803 ••• 1120`: first four and last four digits of a local mobile number. */
export function maskMobileForMessage(phone: string): string {
  return `${phone.slice(0, 4)} ••• ${phone.slice(-4)}`;
}

/** Digits only, allowing spaces and dashes between groups. */
function digitsOf(raw: string): string | null {
  const compact = raw.trim().replace(/[\s-]/g, "");
  return /^\d+$/.test(compact) ? compact : null;
}

export type DigitsCheck =
  | { ok: true; value: string }
  | { ok: false; reason: "not_digits" }
  | { ok: false; reason: "wrong_length"; digits: number };

function checkDigits(raw: string, length: number): DigitsCheck {
  const digits = digitsOf(raw);
  if (digits === null) return { ok: false, reason: "not_digits" };
  if (digits.length !== length) return { ok: false, reason: "wrong_length", digits: digits.length };
  return { ok: true, value: digits };
}

/** NUBAN bank account number: exactly 10 digits. */
export function checkNuban(raw: string): DigitsCheck {
  return checkDigits(raw, 10);
}

/** NIN: exactly 11 digits (format check only, owner decision 8). */
export function checkNin(raw: string): DigitsCheck {
  return checkDigits(raw, 11);
}

const EMPLOYMENT_TYPES: Record<string, EmploymentType> = {
  permanent: "permanent",
  contract: "contract",
  casual: "casual",
  daily: "daily",
};

export function parseEmploymentType(raw: string): Parsed<EmploymentType> {
  const value = EMPLOYMENT_TYPES[raw.trim().toLowerCase()];
  return value ? { ok: true, value } : { ok: false };
}

export type PayTypeCheck =
  { ok: true; value: "monthly" | "daily" } | { ok: false; reason: "hourly" | "unknown" };

export function parsePayType(raw: string): PayTypeCheck {
  const value = raw.trim().toLowerCase();
  if (value === "monthly") return { ok: true, value: "monthly" };
  if (value === "daily") return { ok: true, value: "daily" };
  if (value === "hourly") return { ok: false, reason: "hourly" };
  return { ok: false, reason: "unknown" };
}

const YES = new Set(["y", "yes", "true", "1"]);
const NO = new Set(["n", "no", "false", "0"]);

/** Y/N, yes/no, true/false or 1/0. */
export function parseYesNo(raw: string): Parsed<boolean> {
  const value = raw.trim().toLowerCase();
  if (YES.has(value)) return { ok: true, value: true };
  if (NO.has(value)) return { ok: true, value: false };
  return { ok: false };
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_FIRST_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function toInt(digits: string): number {
  // Digit-only strings of at most four characters: exact in any number type.
  let out = 0;
  for (const char of digits) out = out * 10 + (char.charCodeAt(0) - 48);
  return out;
}

/**
 * A calendar date as `YYYY-MM-DD`. Accepts ISO (`2024-03-01`) and day-first `DD/MM/YYYY`
 * (`01/03/2024`), the way dates are written in Nigeria. Excel date cells arrive already in ISO
 * form. Years 1900 to 2100.
 */
export function parseImportDate(raw: string): Parsed<string> {
  const value = raw.trim();
  let year: number;
  let month: number;
  let day: number;
  const iso = ISO_DATE.exec(value);
  const dayFirst = iso ? null : DAY_FIRST_DATE.exec(value);
  if (iso) {
    year = toInt(iso[1] ?? "");
    month = toInt(iso[2] ?? "");
    day = toInt(iso[3] ?? "");
  } else if (dayFirst) {
    day = toInt(dayFirst[1] ?? "");
    month = toInt(dayFirst[2] ?? "");
    year = toInt(dayFirst[3] ?? "");
  } else {
    return { ok: false };
  }
  if (year < 1900 || year > 2100 || month < 1 || month > 12) return { ok: false };
  const maxDay = month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
  if (day < 1 || day > maxDay) return { ok: false };
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  return { ok: true, value: `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` };
}

/** Light email shape check: one @, no spaces, a dot in the domain. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseImportEmail(raw: string): Parsed<string> {
  const value = raw.trim().toLowerCase();
  return EMAIL.test(value) && value.length <= 320 ? { ok: true, value } : { ok: false };
}
