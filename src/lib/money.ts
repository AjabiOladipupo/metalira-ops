/**
 * Money helpers. Every amount is integer kobo held in a `bigint` (CLAUDE.md rule 1).
 *
 * - No `Number` arithmetic on money anywhere in this file; numbers are accepted only at the
 *   boundary (`toKobo`) and only when they are safe integers.
 * - Rounding is half away from zero ("half-up" for positives, symmetric for negatives), so a
 *   reversal mirrors the original line exactly (owner decision, 15 Nov 2026).
 * - Format only at the edge with `formatNaira()`.
 *
 * Isomorphic: safe to import from server and client code.
 */

export type Kobo = bigint;
export type Currency = "NGN";

export interface Money {
  amountKobo: Kobo;
  currency: Currency;
}

export const KOBO_PER_NAIRA = 100n;
export const BPS_DENOMINATOR = 10_000n;

const INTEGER_STRING = /^-?\d+$/;

/**
 * Converts a value that represents whole kobo into a `bigint`.
 *
 * Accepts what Postgres/PostgREST hands back for a `bigint` column: a JSON number (safe
 * integers only) or a string of digits. Throws on fractions, NaN, unsafe numbers and junk.
 */
export function toKobo(value: bigint | number | string): Kobo {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`toKobo: ${value} is not a safe integer number of kobo`);
    }
    return BigInt(value);
  }
  const trimmed = value.trim();
  if (!INTEGER_STRING.test(trimmed)) {
    throw new RangeError(`toKobo: "${value}" is not an integer number of kobo`);
  }
  return BigInt(trimmed);
}

const NAIRA_INPUT = /^(-)?₦?(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/;

/**
 * Parses a naira amount typed by a person (or read from a fixture) into kobo.
 *
 * Accepts an optional leading minus, an optional ₦ sign (only as a prefix, after any minus),
 * spaces, comma thousands separators (correctly grouped) and up to two decimals: "₦642,312.50"
 * gives 64231250n, "0.5" gives 50n. Rejects more than two decimals, a ₦ anywhere but the front,
 * empty input and anything else.
 *
 * For people's input only. Amounts from a payment provider go through the adapter's own strict
 * parser (no sign, symbol or commas).
 */
export function parseNairaToKobo(input: string): Kobo {
  const cleaned = input.replace(/[\s ]/g, "");
  const match = NAIRA_INPUT.exec(cleaned);
  if (!match) {
    throw new RangeError(`parseNairaToKobo: "${input}" is not a naira amount`);
  }
  const [, minus, wholePart = "", fraction = ""] = match;
  const naira = BigInt(wholePart.replace(/,/g, ""));
  const kobo = BigInt(fraction.padEnd(2, "0"));
  const total = naira * KOBO_PER_NAIRA + kobo;
  return minus ? -total : total;
}

/**
 * Integer division `num / den` rounded half away from zero.
 * (5, 10) gives 1; (4, 10) gives 0; (15, 10) gives 2; (-5, 10) gives -1.
 */
export function roundHalfUp(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new RangeError("roundHalfUp: denominator must be positive");
  const quotient = num / den; // truncates toward zero
  const remainder = num % den; // takes the sign of num
  const absRemainder = remainder < 0n ? -remainder : remainder;
  if (absRemainder * 2n >= den) {
    return num < 0n ? quotient - 1n : quotient + 1n;
  }
  return quotient;
}

function toBigIntInteger(value: bigint | number, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label}: ${value} is not a safe integer`);
  }
  return BigInt(value);
}

/**
 * Applies a rate in basis points (1 bps = 0.01%) and rounds half away from zero once.
 * 750 bps (7.5% VAT) of 59750000n gives 4481250n.
 */
export function applyBps(amount: Kobo, bps: bigint | number): Kobo {
  return roundHalfUp(amount * toBigIntInteger(bps, "applyBps"), BPS_DENOMINATOR);
}

export function sumKobo(values: readonly Kobo[]): Kobo {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}

/**
 * Splits `total` across `weights` so the parts always sum to `total` exactly
 * (largest-remainder method).
 *
 * Each part first gets floor(|total| x w / W). The kobo left over go one each to the parts with
 * the largest remainders; ties go to the lower index. The sign of `total` is then restored, so a
 * negative split mirrors the positive one. A zero weight always gets 0n.
 */
export function allocateKobo(total: Kobo, weights: readonly bigint[]): Kobo[] {
  if (weights.length === 0) throw new RangeError("allocateKobo: weights must not be empty");
  let weightSum = 0n;
  for (const weight of weights) {
    if (weight < 0n) throw new RangeError("allocateKobo: weights must not be negative");
    weightSum += weight;
  }
  if (weightSum === 0n) throw new RangeError("allocateKobo: weights must not all be zero");

  const negative = total < 0n;
  const absTotal = negative ? -total : total;

  const parts: bigint[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let allocated = 0n;
  weights.forEach((weight, index) => {
    const product = absTotal * weight;
    const base = product / weightSum;
    parts.push(base);
    allocated += base;
    remainders.push({ index, remainder: product % weightSum });
  });

  let leftover = absTotal - allocated; // always < weights.length
  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const { index, remainder } of remainders) {
    if (leftover === 0n) break;
    if (remainder === 0n) continue;
    parts[index] = (parts[index] ?? 0n) + 1n;
    leftover -= 1n;
  }

  return negative ? parts.map((part) => (part === 0n ? 0n : -part)) : parts;
}

/** Splits `total` into `count` parts that differ by at most 1 kobo; earlier parts get the extra. */
export function allocateKoboEvenly(total: Kobo, count: number): Kobo[] {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError("allocateKoboEvenly: count must be a positive integer");
  }
  return allocateKobo(
    total,
    Array.from({ length: count }, () => 1n),
  );
}

function splitKobo(kobo: Kobo): { negative: boolean; naira: bigint; fraction: string } {
  const negative = kobo < 0n;
  const abs = negative ? -kobo : kobo;
  return {
    negative,
    naira: abs / KOBO_PER_NAIRA,
    fraction: (abs % KOBO_PER_NAIRA).toString().padStart(2, "0"),
  };
}

function groupThousands(digits: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}

/**
 * Major-unit decimal string with two places and no grouping, for provider payloads that take
 * naira: 64231250n gives "642312.50"; -5n gives "-0.05".
 */
export function koboToMajorString(kobo: Kobo): string {
  const { negative, naira, fraction } = splitKobo(kobo);
  return `${negative ? "-" : ""}${naira.toString()}.${fraction}`;
}

export interface FormatNairaOptions {
  /**
   * Whole naira for dashboards: rounds half away from zero (₦642,312.50 shows ₦642,313).
   * Documents keep the default two decimals.
   */
  whole?: boolean;
}

/**
 * Formats kobo as naira for display. Documents: "₦642,312.50". Dashboards (`whole: true`):
 * "₦642,313". Negatives: "-₦1,000.00". Exact for any size (no Intl, no floats).
 */
export function formatNaira(kobo: Kobo, options: FormatNairaOptions = {}): string {
  if (options.whole) {
    const naira = roundHalfUp(kobo, KOBO_PER_NAIRA);
    const negative = naira < 0n;
    const digits = (negative ? -naira : naira).toString();
    return `${negative ? "-" : ""}₦${groupThousands(digits)}`;
  }
  const { negative, naira, fraction } = splitKobo(kobo);
  return `${negative ? "-" : ""}₦${groupThousands(naira.toString())}.${fraction}`;
}
