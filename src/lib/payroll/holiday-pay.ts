import { roundHalfUp, type Kobo } from "@/lib/money";

/**
 * The company's extra pay for public-holiday work (slice 5.9c; adviser answer 24, owner decision).
 * Pure and isomorphic, for the settings form and the server. Every minute worked on a public
 * holiday earns normal pay plus extra pay of the hourly (overtime) rate × the multiplier
 * (`payroll_holiday_pay_rates.multiplier_bps`, 10000 = 1.0×).
 */

const BPS = 10_000n;

/** "1.5" → 15000 basis points; 1.0 to 5.0, up to two decimals; null otherwise. */
export function parseMultiplierBps(input: string): number | null {
  const m = /^(\d)(?:\.(\d{1,2}))?$/.exec(input.trim().replace(/[x×]$/i, ""));
  if (!m) return null;
  const bps = Number(m[1]) * 10_000 + Number((m[2] ?? "").padEnd(2, "0")) * 100;
  return bps >= 10_000 && bps <= 50_000 ? bps : null;
}

/** An hour of holiday work at ₦750 normal: ₦750 + ₦750 × the multiplier (half up), in kobo. */
export function holidayHourExample(bps: number): { normal: Kobo; extra: Kobo; total: Kobo } {
  const normal = 75_000n;
  const extra = roundHalfUp(normal * BigInt(bps), BPS);
  return { normal, extra, total: normal + extra };
}
