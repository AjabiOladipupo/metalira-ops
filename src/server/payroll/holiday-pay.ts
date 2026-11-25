import "server-only";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { formatDate, lagosToday, addDays } from "@/lib/dates";
import { HOLIDAY_MULTIPLIER_DEFAULT_BPS, holidayMultiplierOn } from "@/lib/payroll/earnings";
import { formatNaira, toKobo, type Kobo } from "@/lib/money";
import { LOSS_OF_OFFICE_EXEMPT_DEFAULT_KOBO } from "@/lib/payroll/final-pay";
import { formatMultiplier } from "@/lib/payroll/rule-set";
import { hasPersonalNumber, PERSONAL_NUMBER_MESSAGE } from "@/lib/personal-number";
import type { ManagerRole } from "@/lib/roles";
import type { CapabilityPreview } from "@/server/capabilities/types";
import { MutationError, type MutationContext, type MutationSpec } from "@/server/identity/mutate";
import type { Database } from "@/types/db";

/**
 * The company's public-holiday pay multiplier (slice 5.9c; docs/RULES_NIGERIA.md adviser answer 24
 * and the owner's decision): every minute worked on a public holiday is paid at the overtime rate
 * × this multiplier, on top of normal pay. Default 1.0× (today's rule). Dated, insert-only
 * versions (`payroll_holiday_pay_rates`) from tomorrow or later; owner, hr and finance read and
 * add them in Settings > Payroll rules, audited. The earnings stage uses the version in force on
 * the day worked. Module: payroll.
 */

type Client = SupabaseClient<Database>;

export const HOLIDAY_PAY_EDITORS = [
  "owner",
  "hr",
  "finance",
] as const satisfies readonly ManagerRole[];

export function canSetHolidayPay(role: ManagerRole): boolean {
  return (HOLIDAY_PAY_EDITORS as readonly ManagerRole[]).includes(role);
}

const multiplierMessage = "Enter a multiplier from 1.0 to 5.0, like 1.5";
const reasonMessage = "Give a reason in up to 500 characters, with no web addresses";

/** "1.5" → 15000 basis points; 1.0 to 5.0, up to two decimals. */
export function parseMultiplierBps(input: string): number | null {
  const m = /^(\d)(?:\.(\d{1,2}))?$/.exec(input.trim().replace(/[x×]$/i, ""));
  if (!m) return null;
  const bps = Number(m[1]) * 10_000 + Number((m[2] ?? "").padEnd(2, "0")) * 100;
  return bps >= 10_000 && bps <= 50_000 ? bps : null;
}

export const holidayPaySchema = z.object({
  multiplier: z.string(multiplierMessage).transform((v, ctx): number => {
    const bps = parseMultiplierBps(v);
    if (bps === null) {
      ctx.addIssue({ code: "custom", message: multiplierMessage });
      return z.NEVER;
    }
    return bps;
  }),
  effectiveFrom: z.iso.date("Choose the first day it applies"),
  reason: z
    .string(reasonMessage)
    .trim()
    .min(1, reasonMessage)
    .max(500, reasonMessage)
    .refine((v) => !/[\u0001-\u001f\u007f-\u009f<>]/.test(v), reasonMessage)
    .refine((v) => !/(:\/\/|www\.)/i.test(v), reasonMessage)
    .refine((v) => !hasPersonalNumber(v), PERSONAL_NUMBER_MESSAGE),
});

export interface HolidayPayVersion {
  id: string;
  effectiveFrom: string;
  multiplierBps: number;
  reason: string;
  createdAt: string;
}

export interface HolidayPaySettings {
  /** The multiplier in force today (1.0× when none is set). */
  inForceBps: number;
  /** The version in force today, or null for the default. */
  inForce: HolidayPayVersion | null;
  scheduled: HolidayPayVersion[];
  earlier: HolidayPayVersion[];
}

/** Settings > Payroll rules: the multiplier in force, scheduled and earlier versions. */
export async function loadHolidayPay(
  supabase: Client,
  organisationId: string,
  today: string = lagosToday(),
): Promise<HolidayPaySettings> {
  const { data, error } = await supabase
    .from("payroll_holiday_pay_rates")
    .select("id, effective_from, multiplier_bps, reason, created_at")
    .eq("organisation_id", organisationId)
    .order("effective_from");
  if (error) throw new Error(`Could not read the holiday pay rate (${error.code})`);
  const versions: HolidayPayVersion[] = (data ?? []).map((r) => ({
    id: r.id,
    effectiveFrom: r.effective_from,
    multiplierBps: r.multiplier_bps,
    reason: r.reason,
    createdAt: r.created_at,
  }));
  const past = versions.filter((v) => v.effectiveFrom <= today);
  const inForce = past[past.length - 1] ?? null;
  return {
    inForceBps: holidayMultiplierOn(versions, today),
    inForce,
    scheduled: versions.filter((v) => v.effectiveFrom > today),
    earlier: past.slice(0, -1).reverse(),
  };
}

export function fromHolidayPayDbError(error: Pick<PostgrestError, "code" | "message">): never {
  if (error.code === "42501") {
    throw new MutationError(
      "forbidden",
      "Only an owner, HR or Finance can set the holiday pay rate.",
    );
  }
  if (error.code === "23514") throw new MutationError("invalid", `${PERSONAL_NUMBER_MESSAGE}.`);
  if (error.code === "MLTB3" || error.code === "22023") {
    throw new MutationError("invalid", error.message);
  }
  throw new Error(`Database refused the change (${error.code})`);
}

/** 8 hours at ₦750 an hour × the multiplier, in kobo (the preview's example). */
const eightHours = (bps: number) =>
  (600_000n * BigInt(bps)) / BigInt(HOLIDAY_MULTIPLIER_DEFAULT_BPS);

/** The preview: the multiplier from that day before and after, and what an hour pays. */
export async function previewSetHolidayPay(
  ctx: Pick<MutationContext, "supabase" | "organisationId">,
  data: z.output<typeof holidayPaySchema>,
): Promise<CapabilityPreview> {
  const tomorrow = addDays(lagosToday(), 1);
  if (data.effectiveFrom < tomorrow) {
    throw new MutationError("invalid", "A new holiday pay rate starts tomorrow or later.", {
      effectiveFrom: "Choose tomorrow or a later day",
    });
  }
  const { data: rows, error } = await ctx.supabase
    .from("payroll_holiday_pay_rates")
    .select("effective_from, multiplier_bps")
    .eq("organisation_id", ctx.organisationId);
  if (error) fromHolidayPayDbError(error);
  const before = holidayMultiplierOn(
    (rows ?? []).map((r) => ({ effectiveFrom: r.effective_from, multiplierBps: r.multiplier_bps })),
    data.effectiveFrom,
  );
  return {
    summary: `From ${formatDate(data.effectiveFrom)}, public-holiday work is paid at the overtime rate × ${formatMultiplier(data.multiplier)} on top of normal pay (${formatMultiplier(before)} before). Days worked before then keep the rate in force on the day. Runs already worked out change only when recalculated.`,
    changes: [
      {
        label: "Holiday pay multiplier",
        before: formatMultiplier(before),
        after: formatMultiplier(data.multiplier),
      },
      { label: "From", after: formatDate(data.effectiveFrom) },
      {
        label: "8 hours on a holiday, at ₦750 an hour overtime",
        before: formatNaira(eightHours(before), { whole: true }),
        after: formatNaira(eightHours(data.multiplier), { whole: true }),
      },
    ],
  };
}

export const setHolidayPaySpec: MutationSpec<
  typeof holidayPaySchema,
  { id: string; effectiveFrom: string }
> = {
  module: "payroll",
  schema: holidayPaySchema,
  roles: HOLIDAY_PAY_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: out, error } = await supabase.rpc("set_holiday_pay_multiplier", {
      p_organisation_id: organisationId,
      p_multiplier_bps: data.multiplier,
      p_effective_from: data.effectiveFrom,
      p_reason: data.reason,
    });
    if (error) fromHolidayPayDbError(error);
    const id = (out as { id?: unknown } | null)?.id;
    return { id: typeof id === "string" ? id : "", effectiveFrom: data.effectiveFrom };
  },
};

/**
 * The loss-of-office exemption on the rule set version in force today (slice 5.9c; adviser
 * answer 19), or the starting ₦50,000,000 before any version is saved.
 */
export async function loadLossOfOfficeCap(
  supabase: Client,
  organisationId: string,
  today: string = lagosToday(),
): Promise<Kobo> {
  const { data, error } = await supabase
    .from("tax_rule_sets")
    .select("loss_of_office_exempt_kobo::text")
    .eq("organisation_id", organisationId)
    .lte("effective_from", today)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Could not read the payroll rules (${error.code})`);
  return data ? toKobo(data.loss_of_office_exempt_kobo) : LOSS_OF_OFFICE_EXEMPT_DEFAULT_KOBO;
}
