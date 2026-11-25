import "server-only";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { formatNaira, parseNairaToKobo, toKobo, type Kobo } from "@/lib/money";
import {
  FINAL_PAY_ITEMS,
  FINAL_PAY_ITEM_TYPES,
  basicDailyRateText,
  planFinalPayItem,
  usesExemption,
  type FinalPayPlan,
  type FinalPayPrefill,
} from "@/lib/payroll/final-pay";
import { hasPersonalNumber, PERSONAL_NUMBER_MESSAGE } from "@/lib/personal-number";
import type { RunAdjustment } from "@/lib/payroll/run";
import type { CapabilityPreview } from "@/server/capabilities/types";
import { MutationError, type MutationContext, type MutationSpec } from "@/server/identity/mutate";
import type { Database } from "@/types/db";

import { calculateRun } from "./run";
import type { PayrollRunRow } from "./run-data";
import {
  PAYROLL_PREPARERS,
  draftRun,
  fromPayrollRunDbError,
  recalculateAndSave,
  targetOf,
} from "./runs";

/**
 * Leavers' final-pay items (slice 5.9c; docs/RULES_NIGERIA.md adviser answer 19): on a final-pay
 * off-cycle draft, HR (or the owner) adds pay in lieu of untaken leave, pay in lieu of notice, a
 * gratuity or a redundancy (loss-of-office) payment. The server works out the pre-filled amount
 * and the exempt part with `src/lib/payroll/final-pay.ts`; `add_final_pay_item` checks both
 * against the database's own figures and writes the item's earning rows, then the run is
 * recalculated. Every write has a preview (the worker's net before and after). Module: payroll.
 */

type Client = SupabaseClient<Database>;

const reload = "Reload the page and try again";
const text = (max: number, what: string) => {
  const message = `${what} in up to ${max} characters, with no web addresses`;
  return z
    .string(message)
    .trim()
    .min(1, message)
    .max(max, message)
    .refine((v) => !/[\u0001-\u001f\u007f-\u009f<>]/.test(v), message)
    .refine((v) => !/(:\/\/|www\.)/i.test(v), message)
    .refine((v) => !hasPersonalNumber(v), PERSONAL_NUMBER_MESSAGE);
};
const amountMessage = "Enter an amount above ₦0, like 15000 or 15,000.50";
const daysMessage = "Enter the days, 1 to 366";

export const finalPayItemSchema = z
  .object({
    runId: z.uuid(reload),
    workerId: z.uuid("Choose a worker"),
    itemType: z.enum(FINAL_PAY_ITEM_TYPES, "Choose the kind of item"),
    days: z
      .string()
      .trim()
      .optional()
      .transform((v, ctx): number | null => {
        if (v === undefined || v === "") return null;
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 366) {
          ctx.addIssue({ code: "custom", message: daysMessage });
          return z.NEVER;
        }
        return n;
      }),
    amount: z
      .string(amountMessage)
      .trim()
      .transform((v, ctx): Kobo => {
        try {
          const kobo = parseNairaToKobo(v);
          if (kobo <= 0n || kobo > 100_000_000_000n) throw new RangeError("out of range");
          return kobo;
        } catch {
          ctx.addIssue({ code: "custom", message: amountMessage });
          return z.NEVER;
        }
      }),
    partOfSettlement: z
      .string()
      .optional()
      .transform((v) => v === "on" || v === "true"),
    reason: text(500, "Give a reason"),
    changeReason: z
      .union([text(500, "Give the reason for the change"), z.literal("")])
      .optional()
      .transform((v) => (v ? v : null)),
    /**
     * Slice 5.10 (money review round 2, M1): the worker already has an item of this type on
     * another standing run, so this one is confirmed as a further item, with why.
     */
    furtherReason: z
      .union([text(500, "Say why this is a further item"), z.literal("")])
      .optional()
      .transform((v) => (v ? v : null)),
  })
  .superRefine((v, ctx) => {
    if (FINAL_PAY_ITEMS[v.itemType].byDays && v.days === null) {
      ctx.addIssue({ code: "custom", message: daysMessage, path: ["days"] });
    }
    if (!FINAL_PAY_ITEMS[v.itemType].byDays && v.days !== null) {
      ctx.addIssue({
        code: "custom",
        message: "Days are only for leave and notice pay",
        path: ["days"],
      });
    }
  });

const prefillRow = z.object({
  worker_id: z.uuid(),
  start_date: z.iso.date(),
  end_date: z.iso.date(),
  basic_monthly_kobo: z.string().regex(/^\d+$/).nullable(),
  divisor_days: z.number().int().min(1),
  leave: z
    .object({
      entitlement_days: z.number().int(),
      months_in_year: z.number().int(),
      taken_days: z.number().int(),
      service_months: z.number().int(),
      paid_elsewhere_days: z.number().int().min(0).optional(),
      days: z.number().int(),
      year: z.number().int(),
    })
    .nullable(),
  exempt_cap_kobo: z.string().regex(/^\d+$/),
  exempt_used_kobo: z.string().regex(/^\d+$/),
  other_run_item_types: z.array(z.enum(FINAL_PAY_ITEM_TYPES)).optional(),
});

/** What the screen pre-fills from, per worker on a final-pay run. */
export async function loadFinalPayPrefill(
  supabase: Client,
  organisationId: string,
  runId: string,
): Promise<Map<string, FinalPayPrefill>> {
  const { data, error } = await supabase.rpc("payroll_final_pay_prefill", {
    p_organisation_id: organisationId,
    p_run_id: runId,
  });
  if (error) throw new Error(`Could not read the final-pay figures (${error.code})`);
  const rows = z.array(prefillRow).parse(data ?? []);
  return new Map(
    rows.map((r) => [
      r.worker_id,
      {
        workerId: r.worker_id,
        startDate: r.start_date,
        endDate: r.end_date,
        basicMonthlyKobo: r.basic_monthly_kobo === null ? null : toKobo(r.basic_monthly_kobo),
        divisorDays: r.divisor_days,
        leave: r.leave
          ? {
              entitlementDays: r.leave.entitlement_days,
              monthsInYear: r.leave.months_in_year,
              takenDays: r.leave.taken_days,
              serviceMonths: r.leave.service_months,
              paidElsewhereDays: r.leave.paid_elsewhere_days ?? 0,
              days: r.leave.days,
              year: r.leave.year,
            }
          : null,
        exemptCapKobo: toKobo(r.exempt_cap_kobo),
        exemptUsedKobo: toKobo(r.exempt_used_kobo),
        otherRunItemTypes: r.other_run_item_types ?? [],
      },
    ]),
  );
}

/** The column checks that hold the personal-number rule (security review L2). */
const PERSONAL_NUMBER_CHECKS = [
  "payroll_final_pay_items_reason_text",
  "payroll_final_pay_items_change_reason_text",
  "payroll_final_pay_items_further_reason_text",
  "payroll_adjustments_label_no_personal_number",
  "payroll_adjustments_reason_no_personal_number",
];

/** Database refusals in plain English. */
export function fromFinalPayDbError(error: Pick<PostgrestError, "code" | "message">): never {
  if (error.code === "23514") {
    if (PERSONAL_NUMBER_CHECKS.some((name) => error.message.includes(name))) {
      throw new MutationError("invalid", `${PERSONAL_NUMBER_MESSAGE}.`);
    }
    throw new MutationError(
      "invalid",
      "That item breaks a payroll rule. Check the figures and try again.",
    );
  }
  if (error.code === "MLFZ1") {
    throw new MutationError("invalid", error.message, { furtherReason: error.message });
  }
  if (/^MLTB[1-5]$/.test(error.code)) {
    if (error.code === "MLTB4") {
      throw new MutationError("invalid", error.message, { changeReason: error.message });
    }
    throw new MutationError("invalid", error.message);
  }
  fromPayrollRunDbError(error);
}

const money = (k: Kobo) => formatNaira(k, { whole: k % 100n === 0n });

interface Planned {
  run: PayrollRunRow;
  prefill: FinalPayPrefill;
  plan: FinalPayPlan;
}

async function planFor(
  ctx: Pick<MutationContext, "supabase" | "organisationId">,
  data: z.output<typeof finalPayItemSchema>,
): Promise<Planned> {
  const run = await draftRun(ctx.supabase, ctx.organisationId, data.runId);
  if (run.kind !== "off_cycle" || run.offCycleReason !== "final_pay") {
    throw new MutationError("invalid", "Final-pay items go only on a final-pay run.");
  }
  const prefill = (await loadFinalPayPrefill(ctx.supabase, ctx.organisationId, run.id)).get(
    data.workerId,
  );
  if (!prefill) throw new MutationError("invalid", "That worker isn't on this final-pay run.");
  const plan = planFinalPayItem(prefill, {
    type: data.itemType,
    days: data.days,
    amountKobo: data.amount,
    partOfSettlement: data.itemType === "notice_in_lieu" && data.partOfSettlement,
  });
  if (plan.needsChangeReason && !data.changeReason) {
    const message =
      plan.computedKobo === null
        ? "There's no pre-filled amount for this worker's pay rate: say how the amount was worked out"
        : "The days or amount differ from the pre-filled figure: give the reason for the change";
    throw new MutationError("invalid", message, { changeReason: message });
  }
  // Slice 5.10 (M1): an item of a type the worker already has on another standing run could pay
  // the same leave, notice or gratuity twice; it needs the explicit further-item reason.
  if ((prefill.otherRunItemTypes ?? []).includes(data.itemType) && !data.furtherReason) {
    const message = `This worker already has ${FINAL_PAY_ITEMS[data.itemType].label.toLowerCase()} on another final-pay run. If this is a further item, not the same one again, say why`;
    throw new MutationError("invalid", message, { furtherReason: message });
  }
  return { run, prefill, plan };
}

/** The item's earning lines as run adjustments, for the preview's calculation. */
function previewLines(workerId: string, plan: FinalPayPlan): RunAdjustment[] {
  return plan.lines.map((l, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i + 1}`,
    workerId,
    kind: "earning",
    label: l.label,
    amountKobo: l.amountKobo,
    pensionable: false,
    taxable: l.taxable,
    instalmentNumber: 1,
    instalmentCount: 1,
  }));
}

export async function previewAddFinalPayItem(
  ctx: Pick<MutationContext, "supabase" | "organisationId">,
  data: z.output<typeof finalPayItemSchema>,
): Promise<CapabilityPreview> {
  const { run, prefill, plan } = await planFor(ctx, data);
  const options = { workerIds: [data.workerId], itfApplies: run.itfApplies };
  const [before, after] = await Promise.all([
    calculateRun(ctx.supabase, ctx.organisationId, targetOf(run), options),
    calculateRun(ctx.supabase, ctx.organisationId, targetOf(run), {
      ...options,
      extraAdjustments: previewLines(data.workerId, plan),
    }),
  ]);
  const net = (calc: typeof before) =>
    calc.workers.find((w) => w.workerId === data.workerId)?.payslip.netKobo ?? null;
  const b = net(before);
  const a = net(after);
  const rule = FINAL_PAY_ITEMS[data.itemType];
  const exempt = usesExemption(
    data.itemType,
    data.itemType === "notice_in_lieu" && data.partOfSettlement,
  );
  const rate = basicDailyRateText(prefill);
  const changes: CapabilityPreview["changes"] = [{ label: "Amount", after: money(data.amount) }];
  if (plan.computedKobo !== null) {
    changes.push({
      label: "Pre-filled",
      after: `${money(plan.computedKobo)} (${data.days} days at ${rate ?? "the basic daily rate"})`,
    });
  }
  if (exempt) {
    changes.push({ label: "Exempt from PAYE", after: money(plan.exemptKobo) });
    changes.push({ label: "Taxable", after: money(plan.taxableKobo) });
    changes.push({
      label: "Exemption left after this",
      after: money(
        prefill.exemptCapKobo - prefill.exemptUsedKobo - plan.exemptKobo > 0n
          ? prefill.exemptCapKobo - prefill.exemptUsedKobo - plan.exemptKobo
          : 0n,
      ),
    });
  }
  changes.push({
    label: "Net pay",
    ...(b !== null ? { before: money(b) } : {}),
    after: a === null ? "Can't be worked out" : money(a),
  });
  return {
    summary: `Adds ${rule.label.toLowerCase()} of ${money(data.amount)}${exempt ? `, ${money(plan.exemptKobo)} of it exempt from PAYE` : ", taxable"} and not pensionable: this worker's net pay ${b === null ? "can't be worked out yet" : money(b)} becomes ${a === null ? "something that can't be worked out" : money(a)}. The run is recalculated.${plan.belowLeaveService ? " Below 6 months' service, leave in lieu isn't owed by law: pay it only if the contract says so." : ""}`,
    changes,
  };
}

export const addFinalPayItemSpec: MutationSpec<typeof finalPayItemSchema, { runId: string }> = {
  module: "payroll",
  schema: finalPayItemSchema,
  roles: PAYROLL_PREPARERS,
  run: async (ctx) => {
    const d = ctx.data;
    const { run, plan } = await planFor(ctx, d);
    const settlement = d.itemType === "notice_in_lieu" && d.partOfSettlement;
    const { error } = await ctx.supabase.rpc("add_final_pay_item", {
      p_organisation_id: ctx.organisationId,
      p_run_id: run.id,
      p_worker_id: d.workerId,
      p_item_type: d.itemType,
      // Whole kobo as text: no number ever holds kobo.
      p_amount_kobo: d.amount.toString(),
      p_reason: d.reason,
      ...(d.days !== null ? { p_days: d.days } : {}),
      ...(plan.computedKobo !== null ? { p_computed_kobo: plan.computedKobo.toString() } : {}),
      ...(usesExemption(d.itemType, settlement)
        ? { p_exempt_kobo: plan.exemptKobo.toString() }
        : {}),
      p_part_of_settlement: settlement,
      ...(d.changeReason ? { p_change_reason: d.changeReason } : {}),
      ...(d.furtherReason ? { p_further_reason: d.furtherReason } : {}),
    });
    if (error) fromFinalPayDbError(error);
    const fresh = await draftRun(ctx.supabase, ctx.organisationId, run.id);
    await recalculateAndSave(ctx, fresh);
    return { runId: run.id };
  },
};

/**
 * Exempt splits that went stale (money review L1): an item's exempt part is fixed when it is
 * added, so when a run whose items used the worker's cap is later discarded or reversed, an item
 * here could now be exempt on more. Returns those items' ids; the screen asks HR to remove and add
 * them again. Never the other way: a split can't exceed the cap, because later items count it.
 */
export async function staleExemptItems(
  supabase: Client,
  organisationId: string,
  runId: string,
  prefill: Map<string, FinalPayPrefill>,
): Promise<Set<string>> {
  const { data: mine, error } = await supabase
    .from("payroll_final_pay_items")
    .select("id, worker_id, amount_kobo::text, exempt_kobo::text, exempt_cap_kobo")
    .eq("organisation_id", organisationId)
    .eq("run_id", runId)
    .not("exempt_cap_kobo", "is", null);
  if (error) throw new Error(`Could not read the final-pay items (${error.code})`);
  const stale = new Set<string>();
  if (!mine || mine.length === 0) return stale;
  const workers = [...new Set(mine.map((i) => i.worker_id))];
  const { data: all, error: allError } = await supabase
    .from("payroll_final_pay_items")
    .select(
      "id, worker_id, exempt_kobo::text, payroll_runs!payroll_final_pay_items_run_fkey ( status, kind, discarded_at )",
    )
    .eq("organisation_id", organisationId)
    .in("worker_id", workers);
  if (allError) throw new Error(`Could not read the final-pay items (${allError.code})`);
  const live = (all ?? []).filter(
    (i) =>
      i.payroll_runs !== null &&
      i.payroll_runs.status !== "reversed" &&
      i.payroll_runs.kind !== "reversal" &&
      i.payroll_runs.discarded_at === null,
  );
  for (const item of mine) {
    const p = prefill.get(item.worker_id);
    if (!p) continue;
    const others = live
      .filter((i) => i.worker_id === item.worker_id && i.id !== item.id)
      .reduce((n, i) => n + toKobo(i.exempt_kobo), 0n);
    const room = p.exemptCapKobo - others > 0n ? p.exemptCapKobo - others : 0n;
    const amount = toKobo(item.amount_kobo);
    const now = amount < room ? amount : room;
    if (now > toKobo(item.exempt_kobo)) stale.add(item.id);
  }
  return stale;
}
