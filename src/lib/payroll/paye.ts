import { BPS_DENOMINATOR, roundHalfUp, type Kobo } from "@/lib/money";

import type { PayeBand } from "./rule-set";

/**
 * PAYE through the annual bands (slice 5.0; docs/RULES_NIGERIA.md "PAYE"). Pure, `bigint` only.
 *
 * Tax is kept as an exact fraction of a kobo and rounded once, half up, at the monthly figure
 * (RULES_NIGERIA "Rounding"; PHASE_5 "Rounding"): annual tax = Σ portion in band × rate, and
 * monthly PAYE = annual tax ÷ 12. Taxable income itself may be a fraction (20% rent relief of a
 * rent that isn't a multiple of 5 kobo), so it comes in as one too.
 */

/** An exact non-negative amount of kobo: `num / den`, `den > 0`. */
export interface Fraction {
  num: bigint;
  den: bigint;
}

export function fraction(num: bigint, den: bigint = 1n): Fraction {
  if (den <= 0n) throw new RangeError("fraction: denominator must be positive");
  return { num, den };
}

/** The fraction rounded half up to whole kobo (for display; never fed back into maths). */
export function roundFraction(f: Fraction): Kobo {
  return roundHalfUp(f.num, f.den);
}

/** True when the fraction is a whole number of kobo. */
export function isWhole(f: Fraction): boolean {
  return f.num % f.den === 0n;
}

export interface BandPortion {
  /** Index of the band in the rule set. */
  band: number;
  rateBps: number;
  /** Where the band starts, in kobo of annual taxable income. */
  lowerKobo: Kobo;
  /** The band's width, or null for the open top band. */
  widthKobo: Kobo | null;
  /** The part of taxable income in this band. */
  portion: Fraction;
  /** Tax on that part. */
  tax: Fraction;
}

export interface AnnualPaye {
  /** Exact annual tax, denominator `taxable.den × 10000`. */
  tax: Fraction;
  /** One entry per band that holds part of the income, lowest first. */
  portions: BandPortion[];
}

/**
 * Annual tax on `taxable` (annual kobo, exact) through `bands`. A negative taxable income is
 * treated as 0; the caller floors it first and the trace says so.
 */
export function annualPaye(taxable: Fraction, bands: readonly PayeBand[]): AnnualPaye {
  if (bands.length === 0) throw new RangeError("annualPaye: no bands");
  const den = taxable.den;
  const taxDen = den * BPS_DENOMINATOR;
  let remaining = taxable.num > 0n ? taxable.num : 0n;
  let lower = 0n;
  let taxNum = 0n;
  const portions: BandPortion[] = [];
  bands.forEach((band, i) => {
    if (remaining <= 0n) return;
    const last = i === bands.length - 1;
    if (band.widthKobo === null && !last)
      throw new RangeError("annualPaye: only the last band is open");
    const cap = band.widthKobo === null ? remaining : band.widthKobo * den;
    const inBand = remaining < cap ? remaining : cap;
    const bandTax = inBand * BigInt(band.rateBps);
    taxNum += bandTax;
    portions.push({
      band: i,
      rateBps: band.rateBps,
      lowerKobo: lower,
      widthKobo: band.widthKobo,
      portion: { num: inBand, den },
      tax: { num: bandTax, den: taxDen },
    });
    remaining -= inBand;
    if (band.widthKobo !== null) lower += band.widthKobo;
  });
  if (remaining > 0n) throw new RangeError("annualPaye: the last band must be open");
  return { tax: { num: taxNum, den: taxDen }, portions };
}

/** Monthly PAYE: annual tax ÷ 12, rounded half up once, to the kobo. */
export function monthlyPaye(annualTax: Fraction): Kobo {
  return roundHalfUp(annualTax.num, annualTax.den * 12n);
}

/** Monthly PAYE for a whole-kobo annual taxable income (tests and previews). */
export function monthlyPayeOnAnnual(taxableKobo: Kobo, bands: readonly PayeBand[]): Kobo {
  return monthlyPaye(annualPaye(fraction(taxableKobo), bands).tax);
}
