import { z } from "zod";

import { formatNaira, type Kobo } from "@/lib/money";

/**
 * Tax rule sets (slice 5.0; docs/PHASE_5.md "Calculation design", docs/RULES_NIGERIA.md). Pure.
 *
 * A rule set is a dated version (`tax_rule_sets`, rule 3) holding every statutory figure the
 * gross-to-net engine uses (`rules`) and the owner's pay-policy figures the earnings stage uses
 * (`policy`). The database stores them as jsonb with kobo as strings of digits (a JSON number
 * can't hold every bigint); `parseRuleSet` turns that into `RuleSet` with `bigint` kobo, and
 * `ruleSetRulesJson` / `ruleSetPolicyJson` turn it back.
 *
 * `NTA_2025_V1` is the starting version. It must equal docs/RULES_NIGERIA.md figure by figure
 * (tests/unit/payroll/rule-set.test.ts reads the doc) and the database's
 * private.tax_rule_set_template() (tests/rls/tax-rule-sets.test.ts). Every figure is
 * "confirm with a tax adviser before the first live payroll" until the adviser's confirmation
 * is recorded on the version.
 */

/** Shown beside every statutory figure until `adviser_confirmed_at` is set. */
export const TAX_ADVISER_LINE = "Confirm with a tax adviser before the first live payroll.";

/** Salary components a rule's base may name. */
export const SALARY_COMPONENTS = ["basic", "housing", "transport", "other_allowances"] as const;
export type SalaryComponent = (typeof SALARY_COMPONENTS)[number];

export interface PayeBand {
  /** Width of the band in kobo ("Next ₦2,200,000"); null for the last, open band. */
  widthKobo: Kobo | null;
  /** Rate in basis points (1500 = 15%). */
  rateBps: number;
}

export interface TaxRules {
  /** Annual bands on taxable income, lowest first; only the last is open. */
  payeBands: PayeBand[];
  rentRelief: { rateBps: number; capKobo: Kobo };
  pension: { employeeBps: number; employerBps: number; base: SalaryComponent[] };
  nhf: { rateBps: number; base: SalaryComponent[] };
  nsitf: { rateBps: number };
  itf: { rateBps: number; minStaff: number };
  /** Daily workers pay no PAYE, pension, NHF, NSITF or ITF and are left out of the levy base. */
  dailyWorkersExempt: boolean;
}

export const PUBLIC_HOLIDAY_MODES = ["worked_minutes_at_overtime_rate"] as const;
export type PublicHolidayMode = (typeof PUBLIC_HOLIDAY_MODES)[number];

export interface PayPolicy {
  /** Overtime multiplier in basis points (10000 = 1.0×). */
  overtimeMultiplierBps: number;
  /** Minutes paid at the overtime rate for an approved off-day (480 = one 8-hour shift). */
  offDayPaidMinutes: number;
  /** How public-holiday work is paid (open question 1's default). */
  publicHolidayMode: PublicHolidayMode;
}

export interface RuleSet {
  name: string;
  rules: TaxRules;
  policy: PayPolicy;
}

const naira = (n: bigint): Kobo => n * 100n;

/**
 * The starting rule set: docs/RULES_NIGERIA.md (Nigeria Tax Act 2025 from 1 Jan 2026, PRA 2014,
 * NHF, NSITF, ITF) and the owner's pay policy of 15 Nov 2026. Confirm with a tax adviser.
 */
export const NTA_2025_V1: RuleSet = {
  name: "NTA 2025 v1",
  rules: {
    payeBands: [
      { widthKobo: naira(800_000n), rateBps: 0 },
      { widthKobo: naira(2_200_000n), rateBps: 1500 },
      { widthKobo: naira(9_000_000n), rateBps: 1800 },
      { widthKobo: naira(13_000_000n), rateBps: 2100 },
      { widthKobo: naira(25_000_000n), rateBps: 2300 },
      { widthKobo: null, rateBps: 2500 },
    ],
    rentRelief: { rateBps: 2000, capKobo: naira(500_000n) },
    pension: { employeeBps: 800, employerBps: 1000, base: ["basic", "housing", "transport"] },
    nhf: { rateBps: 250, base: ["basic"] },
    nsitf: { rateBps: 100 },
    itf: { rateBps: 100, minStaff: 5 },
    dailyWorkersExempt: true,
  },
  policy: {
    overtimeMultiplierBps: 10_000,
    offDayPaidMinutes: 480,
    publicHolidayMode: "worked_minutes_at_overtime_rate",
  },
};

export const NTA_2025_V1_EFFECTIVE_FROM = "2026-01-01";
export const NTA_2025_V1_SOURCE =
  "Nigeria Tax Act 2025 bands from 1 Jan 2026, Pension Reform Act 2014, NHF, NSITF and ITF; Metalira's default pay policy";

// ---------------------------------------------------------------------------
// The jsonb shape (snake case, kobo as digit strings) and its Zod schema
// ---------------------------------------------------------------------------

const MAX_KOBO = 10n ** 15n; // ₦10 trillion: far above any band, keeps SQL bigint safe

const bps = z.number().int().min(0).max(10_000);
const koboString = z
  .string()
  .regex(/^\d{1,16}$/, "kobo as whole digits")
  .transform((v) => BigInt(v))
  .refine((v) => v <= MAX_KOBO, "too large");
const components = z
  .array(z.enum(SALARY_COMPONENTS))
  .min(1)
  .max(SALARY_COMPONENTS.length)
  .refine((v) => new Set(v).size === v.length, "each component once");

export const taxRulesJsonSchema = z
  .strictObject({
    paye_bands: z
      .array(z.strictObject({ width_kobo: koboString.nullable(), rate_bps: bps }))
      .min(1)
      .max(12),
    rent_relief: z.strictObject({ rate_bps: bps, cap_kobo: koboString }),
    pension: z.strictObject({ employee_bps: bps, employer_bps: bps, base: components }),
    nhf: z.strictObject({ rate_bps: bps, base: components }),
    nsitf: z.strictObject({ rate_bps: bps }),
    itf: z.strictObject({ rate_bps: bps, min_staff: z.number().int().min(1).max(100_000) }),
    daily_workers_exempt: z.boolean(),
  })
  .superRefine((v, ctx) => {
    v.paye_bands.forEach((band, i) => {
      const last = i === v.paye_bands.length - 1;
      if (last && band.width_kobo !== null) {
        ctx.addIssue({
          code: "custom",
          message: "The last band has no upper limit.",
          path: ["paye_bands", i],
        });
      }
      if (!last && (band.width_kobo === null || band.width_kobo <= 0n)) {
        ctx.addIssue({
          code: "custom",
          message: "Every band but the last has a width above ₦0.",
          path: ["paye_bands", i],
        });
      }
    });
  });

export const payPolicyJsonSchema = z.strictObject({
  overtime_multiplier_bps: z.number().int().min(10_000).max(50_000),
  off_day_paid_minutes: z.number().int().min(0).max(1_440),
  public_holiday_mode: z.enum(PUBLIC_HOLIDAY_MODES),
});

export type TaxRulesJson = z.input<typeof taxRulesJsonSchema>;
export type PayPolicyJson = z.input<typeof payPolicyJsonSchema>;

/** Parses a version's stored `rules` and `policy` (throws a ZodError on a bad shape). */
export function parseRuleSet(name: string, rules: unknown, policy: unknown): RuleSet {
  const r = taxRulesJsonSchema.parse(rules);
  const p = payPolicyJsonSchema.parse(policy);
  return {
    name,
    rules: {
      payeBands: r.paye_bands.map((b) => ({ widthKobo: b.width_kobo, rateBps: b.rate_bps })),
      rentRelief: { rateBps: r.rent_relief.rate_bps, capKobo: r.rent_relief.cap_kobo },
      pension: {
        employeeBps: r.pension.employee_bps,
        employerBps: r.pension.employer_bps,
        base: [...r.pension.base],
      },
      nhf: { rateBps: r.nhf.rate_bps, base: [...r.nhf.base] },
      nsitf: { rateBps: r.nsitf.rate_bps },
      itf: { rateBps: r.itf.rate_bps, minStaff: r.itf.min_staff },
      dailyWorkersExempt: r.daily_workers_exempt,
    },
    policy: {
      overtimeMultiplierBps: p.overtime_multiplier_bps,
      offDayPaidMinutes: p.off_day_paid_minutes,
      publicHolidayMode: p.public_holiday_mode,
    },
  };
}

/** The jsonb `rules` document for a rule set (keys in a fixed order). */
export function ruleSetRulesJson(rules: TaxRules): TaxRulesJson {
  return {
    paye_bands: rules.payeBands.map((b) => ({
      width_kobo: b.widthKobo === null ? null : b.widthKobo.toString(),
      rate_bps: b.rateBps,
    })),
    rent_relief: {
      rate_bps: rules.rentRelief.rateBps,
      cap_kobo: rules.rentRelief.capKobo.toString(),
    },
    pension: {
      employee_bps: rules.pension.employeeBps,
      employer_bps: rules.pension.employerBps,
      base: [...rules.pension.base],
    },
    nhf: { rate_bps: rules.nhf.rateBps, base: [...rules.nhf.base] },
    nsitf: { rate_bps: rules.nsitf.rateBps },
    itf: { rate_bps: rules.itf.rateBps, min_staff: rules.itf.minStaff },
    daily_workers_exempt: rules.dailyWorkersExempt,
  };
}

/** The jsonb `policy` document for a rule set. */
export function ruleSetPolicyJson(policy: PayPolicy): PayPolicyJson {
  return {
    overtime_multiplier_bps: policy.overtimeMultiplierBps,
    off_day_paid_minutes: policy.offDayPaidMinutes,
    public_holiday_mode: policy.publicHolidayMode,
  };
}

// ---------------------------------------------------------------------------
// Plain-English figures, for Settings > Payroll rules, the preview and the trace
// ---------------------------------------------------------------------------

/** "15%", "2.5%", "0.75%": basis points as a percentage, exact. */
export function formatBps(rateBps: number): string {
  const whole = Math.trunc(rateBps / 100);
  const frac = rateBps % 100;
  if (frac === 0) return `${whole}%`;
  return `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}%`;
}

const COMPONENT_LABELS: Record<SalaryComponent, string> = {
  basic: "basic",
  housing: "housing",
  transport: "transport",
  other_allowances: "other allowances",
};

export function formatComponents(base: readonly SalaryComponent[]): string {
  const words = base.map((c) => COMPONENT_LABELS[c]);
  return words.join(" + ");
}

export interface RuleFigure {
  /** Stable key, for comparing two versions. */
  key: string;
  label: string;
  value: string;
}

/** Every figure of a rule set as label and value, in the order Settings shows them. */
export function ruleSetFigures(set: RuleSet): RuleFigure[] {
  const { rules, policy } = set;
  const out: RuleFigure[] = [];
  let lower = 0n;
  rules.payeBands.forEach((band, i) => {
    const label =
      band.widthKobo === null
        ? `PAYE above ${formatNaira(lower, { whole: true })}`
        : i === 0
          ? `PAYE on the first ${formatNaira(band.widthKobo, { whole: true })}`
          : `PAYE on the next ${formatNaira(band.widthKobo, { whole: true })}`;
    out.push({ key: `paye_band_${i}`, label, value: formatBps(band.rateBps) });
    if (band.widthKobo !== null) lower += band.widthKobo;
  });
  out.push(
    {
      key: "rent_relief",
      label: "Rent relief",
      value: `${formatBps(rules.rentRelief.rateBps)} of declared annual rent, capped at ${formatNaira(rules.rentRelief.capKobo, { whole: true })}`,
    },
    {
      key: "pension_employee",
      label: "Employee pension",
      value: `${formatBps(rules.pension.employeeBps)} of ${formatComponents(rules.pension.base)}`,
    },
    {
      key: "pension_employer",
      label: "Employer pension",
      value: `${formatBps(rules.pension.employerBps)} of ${formatComponents(rules.pension.base)}`,
    },
    {
      key: "nhf",
      label: "NHF",
      value: `${formatBps(rules.nhf.rateBps)} of ${formatComponents(rules.nhf.base)}, only for workers who opted in`,
    },
    { key: "nsitf", label: "NSITF", value: `${formatBps(rules.nsitf.rateBps)} of monthly payroll` },
    {
      key: "itf",
      label: "ITF",
      value: `${formatBps(rules.itf.rateBps)} of payroll, accrued monthly, for ${rules.itf.minStaff} or more staff`,
    },
    {
      key: "daily_workers",
      label: "Daily workers",
      value: rules.dailyWorkersExempt
        ? "No PAYE, pension, NHF, NSITF or ITF; left out of the levy base"
        : "Same deductions as monthly workers",
    },
    {
      key: "overtime_multiplier",
      label: "Overtime rate",
      value: `${formatMultiplier(policy.overtimeMultiplierBps)} the normal hourly rate`,
    },
    {
      key: "off_day_minutes",
      label: "Off-day work",
      value: `${formatMinutes(policy.offDayPaidMinutes)} at the overtime rate`,
    },
    {
      key: "public_holiday_mode",
      label: "Public-holiday work",
      value: "Every minute worked, at the overtime rate, on top of normal pay",
    },
  );
  return out;
}

/** "1.0×", "1.5×". */
export function formatMultiplier(multiplierBps: number): string {
  const whole = Math.trunc(multiplierBps / 10_000);
  const frac = multiplierBps % 10_000;
  const digits = String(frac).padStart(4, "0").replace(/0+$/, "");
  return `${whole}.${digits === "" ? "0" : digits}×`;
}

/** "8 h", "7 h 30 min", "45 min". */
export function formatMinutes(minutes: number): string {
  const h = Math.trunc(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export interface FigureChange {
  label: string;
  before: string | null;
  after: string | null;
}

/** The figures that differ between two rule sets, for the "Add a version" preview. */
export function diffRuleSets(before: RuleSet, after: RuleSet): FigureChange[] {
  const a = new Map(ruleSetFigures(before).map((f) => [f.key, f]));
  const b = ruleSetFigures(after);
  const changes: FigureChange[] = [];
  const seen = new Set<string>();
  for (const f of b) {
    seen.add(f.key);
    const old = a.get(f.key);
    if (!old) changes.push({ label: f.label, before: null, after: f.value });
    else if (old.label !== f.label || old.value !== f.value) {
      changes.push({
        label: old.label === f.label ? f.label : `${old.label} → ${f.label}`,
        before: old.value,
        after: f.value,
      });
    }
  }
  for (const [key, f] of a) {
    if (!seen.has(key)) changes.push({ label: f.label, before: f.value, after: null });
  }
  return changes;
}

/** Whether a component counts toward a base (pension, NHF). */
export function inBase(base: readonly SalaryComponent[], component: SalaryComponent): boolean {
  return base.includes(component);
}
