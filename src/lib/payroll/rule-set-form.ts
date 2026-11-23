import { z } from "zod";

import { parseNairaToKobo } from "@/lib/money";

import {
  PUBLIC_HOLIDAY_MODES,
  SALARY_COMPONENTS,
  payPolicyJsonSchema,
  taxRulesJsonSchema,
  type RuleSet,
  type SalaryComponent,
  type TaxRulesJson,
  type PayPolicyJson,
} from "./rule-set";

/**
 * Settings > Payroll rules > Add a version (slice 5.0): the form's string fields, both ways.
 * Rates are typed as percentages ("2.5"), amounts as naira ("2,200,000"), and become whole basis
 * points and kobo strings for the jsonb. Pure; the database checks the shape again.
 *
 * The bases (what pension and NHF are taken on), the daily-worker exemption and the
 * public-holiday mode travel as hidden fields carried from the version before: the form changes
 * rates and amounts only.
 */

export const MAX_BANDS = 12;

const PERCENT = /^\d{1,3}(\.\d{1,2})?$/;

/** "2.5" → 250, "15" → 1500. Null when it isn't a percentage with up to 2 decimals from 0 to 100. */
export function parsePercentToBps(text: string): number | null {
  const t = text.trim().replace(/%$/, "").trim();
  if (!PERCENT.test(t)) return null;
  const [whole = "0", frac = ""] = t.split(".");
  const bps = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return bps <= 10_000 ? bps : null;
}

/** 250 → "2.5", 1500 → "15". */
export function bpsToPercentText(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = String(bps % 100)
    .padStart(2, "0")
    .replace(/0+$/, "");
  return frac === "" ? String(whole) : `${whole}.${frac}`;
}

/** 10000 → "1", 15000 → "1.5". */
export function multiplierText(bps: number): string {
  const whole = Math.trunc(bps / 10_000);
  const frac = String(bps % 10_000)
    .padStart(4, "0")
    .replace(/0+$/, "");
  return frac === "" ? String(whole) : `${whole}.${frac}`;
}

/** "1.5" → 15000. Null outside 1 to 5 or past 4 decimals. */
export function parseMultiplierToBps(text: string): number | null {
  const t = text.trim().replace(/×$/, "").trim();
  if (!/^\d(\.\d{1,4})?$/.test(t)) return null;
  const [whole = "0", frac = ""] = t.split(".");
  const bps = Number(whole) * 10_000 + Number(frac.padEnd(4, "0"));
  return bps >= 10_000 && bps <= 50_000 ? bps : null;
}

/** 220000000n → "2200000" (naira, no grouping; kobo shown only when there are some). */
export function koboToNairaText(kobo: bigint): string {
  const naira = kobo / 100n;
  const rest = kobo % 100n;
  return rest === 0n ? naira.toString() : `${naira}.${rest.toString().padStart(2, "0")}`;
}

/** The form's fields for a rule set, as the inputs show them. */
export function ruleSetFormValues(set: RuleSet): Record<string, string> {
  const r = set.rules;
  const out: Record<string, string> = {
    bandCount: String(r.payeBands.length),
    rentReliefRate: bpsToPercentText(r.rentRelief.rateBps),
    rentReliefCap: koboToNairaText(r.rentRelief.capKobo),
    pensionEmployeeRate: bpsToPercentText(r.pension.employeeBps),
    pensionEmployerRate: bpsToPercentText(r.pension.employerBps),
    pensionBase: r.pension.base.join(","),
    nhfRate: bpsToPercentText(r.nhf.rateBps),
    nhfBase: r.nhf.base.join(","),
    nsitfRate: bpsToPercentText(r.nsitf.rateBps),
    itfRate: bpsToPercentText(r.itf.rateBps),
    itfMinStaff: String(r.itf.minStaff),
    dailyWorkersExempt: r.dailyWorkersExempt ? "true" : "false",
    overtimeMultiplier: multiplierText(set.policy.overtimeMultiplierBps),
    offDayPaidMinutes: String(set.policy.offDayPaidMinutes),
    publicHolidayMode: set.policy.publicHolidayMode,
  };
  r.payeBands.forEach((band, i) => {
    out[`band${i}Rate`] = bpsToPercentText(band.rateBps);
    if (band.widthKobo !== null) out[`band${i}Width`] = koboToNairaText(band.widthKobo);
  });
  return out;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function plain(max: number, message: string) {
  return z
    .string(message)
    .trim()
    .min(1, message)
    .max(max, message)
    .refine((v) => !/[\u0001-\u001f\u007f-\u009f<>]/.test(v), message)
    .refine((v) => !/(:\/\/|www\.)/i.test(v), message);
}

function baseList(text: string | undefined): SalaryComponent[] | null {
  if (!text) return null;
  const parts = text.split(",").map((p) => p.trim());
  if (!parts.every((p) => (SALARY_COMPONENTS as readonly string[]).includes(p))) return null;
  return parts as SalaryComponent[];
}

export interface RuleSetVersionInput {
  name: string;
  effectiveFrom: string;
  reason: string;
  sourceLabel: string | null;
  rules: TaxRulesJson;
  policy: PayPolicyJson;
}

/**
 * Parses the "Add a version" form (or the same fields from the capability registry). Field
 * errors are keyed by the input's name.
 */
export const ruleSetVersionSchema = z
  .object({
    name: plain(60, "Give the version a name of up to 60 characters, with no web addresses"),
    effectiveFrom: z
      .string("Choose the day the version starts")
      .regex(ISO_DATE, "Choose the day the version starts")
      .refine(
        (v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)),
        "Choose the day the version starts",
      ),
    reason: plain(500, "Give a reason of up to 500 characters, with no web addresses"),
    sourceLabel: z
      .string()
      .trim()
      .max(200, "The source is up to 200 characters")
      .refine(
        (v) => !/[\u0001-\u001f\u007f-\u009f<>]/.test(v),
        "The source has no special characters",
      )
      .refine((v) => !/(:\/\/|www\.)/i.test(v), "The source has no web addresses")
      .optional()
      .transform((v) => (v ? v : null)),
  })
  .catchall(z.unknown())
  .transform((v, ctx): RuleSetVersionInput => {
    const fields = Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, typeof x === "string" ? x : undefined]),
    ) as Record<string, string | undefined>;
    const issue = (path: string, message: string) => {
      ctx.addIssue({ code: "custom", message, path: [path] });
    };
    const rate = (key: string, label: string): number => {
      const bps = parsePercentToBps(fields[key] ?? "");
      if (bps === null) {
        issue(key, `${label} is a percentage from 0 to 100, with up to 2 decimals`);
        return 0;
      }
      return bps;
    };
    const naira = (key: string, label: string, positive: boolean): string => {
      try {
        const kobo = parseNairaToKobo(fields[key] ?? "");
        if (kobo < 0n || (positive && kobo === 0n)) throw new RangeError("range");
        return kobo.toString();
      } catch {
        issue(key, `${label} is an amount in naira${positive ? " above ₦0" : ""}`);
        return "0";
      }
    };

    const count = Number(fields.bandCount ?? "");
    if (!Number.isInteger(count) || count < 1 || count > MAX_BANDS) {
      issue("bandCount", "The bands are missing. Reload the page.");
    }
    const bands: TaxRulesJson["paye_bands"] = [];
    for (let i = 0; i < Math.max(0, Math.min(count, MAX_BANDS)); i++) {
      const last = i === count - 1;
      bands.push({
        width_kobo: last ? null : naira(`band${i}Width`, `Band ${i + 1}'s width`, true),
        rate_bps: rate(`band${i}Rate`, `Band ${i + 1}'s rate`),
      });
    }

    const pensionBase = baseList(fields.pensionBase);
    const nhfBase = baseList(fields.nhfBase);
    if (!pensionBase || !nhfBase) issue("pensionBase", "The bases are missing. Reload the page.");
    const minStaff = /^\d{1,6}$/.test(fields.itfMinStaff?.trim() ?? "")
      ? Number(fields.itfMinStaff)
      : NaN;
    if (!(minStaff >= 1 && minStaff <= 100_000))
      issue("itfMinStaff", "Staff for ITF is a whole number from 1");
    const multiplier = parseMultiplierToBps(fields.overtimeMultiplier ?? "");
    if (multiplier === null)
      issue("overtimeMultiplier", "The overtime rate is from 1 to 5 times, like 1 or 1.5");
    const offDay = /^\d{1,4}$/.test(fields.offDayPaidMinutes?.trim() ?? "")
      ? Number(fields.offDayPaidMinutes)
      : NaN;
    if (!(offDay >= 0 && offDay <= 1_440))
      issue("offDayPaidMinutes", "Off-day minutes are from 0 to 1,440");
    const mode = fields.publicHolidayMode ?? "";
    if (!(PUBLIC_HOLIDAY_MODES as readonly string[]).includes(mode)) {
      issue("publicHolidayMode", "The public-holiday rule is missing. Reload the page.");
    }

    const rules: TaxRulesJson = {
      paye_bands: bands,
      rent_relief: {
        rate_bps: rate("rentReliefRate", "Rent relief"),
        cap_kobo: naira("rentReliefCap", "The rent relief cap", false),
      },
      pension: {
        employee_bps: rate("pensionEmployeeRate", "Employee pension"),
        employer_bps: rate("pensionEmployerRate", "Employer pension"),
        base: pensionBase ?? ["basic"],
      },
      nhf: { rate_bps: rate("nhfRate", "NHF"), base: nhfBase ?? ["basic"] },
      nsitf: { rate_bps: rate("nsitfRate", "NSITF") },
      itf: {
        rate_bps: rate("itfRate", "ITF"),
        min_staff: Number.isFinite(minStaff) ? minStaff : 1,
      },
      daily_workers_exempt: fields.dailyWorkersExempt !== "false",
    };
    const policy: PayPolicyJson = {
      overtime_multiplier_bps: multiplier ?? 10_000,
      off_day_paid_minutes: Number.isFinite(offDay) ? offDay : 0,
      public_holiday_mode: mode as PayPolicyJson["public_holiday_mode"],
    };
    // The same checks the engine and the database make.
    if (taxRulesJsonSchema.safeParse(rules).success === false && ctx.issues.length === 0) {
      issue("bandCount", "The tax figures aren't complete. Reload the page.");
    }
    if (payPolicyJsonSchema.safeParse(policy).success === false && ctx.issues.length === 0) {
      issue("overtimeMultiplier", "The pay-policy figures aren't complete. Reload the page.");
    }
    return {
      name: v.name,
      effectiveFrom: v.effectiveFrom,
      reason: v.reason,
      sourceLabel: v.sourceLabel,
      rules,
      policy,
    };
  });
