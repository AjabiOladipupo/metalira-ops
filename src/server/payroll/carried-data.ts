import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { toKobo, type Kobo } from "@/lib/money";
import {
  carriedLedgers,
  carriedOutstanding,
  type CarriedLedger,
  type CarriedSlip,
} from "@/lib/payroll/carried";
import type { Database } from "@/types/db";

/**
 * Outstanding carried deductions (slice 5.7c, open question 6), read under RLS as the signed-in
 * member: owner, hr and finance read posted runs, payslips and lines; everyone else gets no rows,
 * so the panel is empty. The running balance per worker is worked out by
 * src/lib/payroll/carried.ts from posted payslips (approved or released runs; a reversed run's
 * payslips don't stand). Kobo is read as text and becomes `bigint`. No personal numbers.
 */

type Client = SupabaseClient<Database>;

const POSTED = ["approved", "released"];
const CHUNK = 200;
const PAGE = 1000;

export interface CarriedWorker extends CarriedLedger {
  workerName: string;
  staffId: string;
}

/**
 * A recurring instalment a regular run didn't carry because the worker's final pay (5.7b) had
 * already posted: payroll settles it knowingly (an adjustment on a correction run, or off the
 * books with the worker).
 */
export interface InstalmentNotCarried {
  workerId: string;
  workerName: string;
  seriesId: string;
  instalment: number;
  of: number;
  amountKobo: Kobo;
  at: string;
}

export interface CarriedDeductions {
  workers: CarriedWorker[];
  /** Σ balances still owed. */
  outstandingKobo: Kobo;
  notCarried: InstalmentNotCarried[];
}

/** Each worker who carried a deduction, with their running balance across posted runs. */
export async function loadCarriedDeductions(
  supabase: Client,
  organisationId: string,
): Promise<CarriedDeductions> {
  // Every posted run, paged (money review M5: never a cap that could understate what's owed).
  const runs: {
    id: string;
    kind: string;
    off_cycle_reason: string | null;
    period_start: string;
    period_end: string;
    pay_date: string;
    approved_at: string | null;
  }[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("payroll_runs")
      .select("id, kind, off_cycle_reason, period_start, period_end, pay_date, approved_at")
      .eq("organisation_id", organisationId)
      .in("status", POSTED)
      // A reversal run's payslips are signed copies (slice 5.7a), not pay.
      .neq("kind", "reversal")
      .order("period_start", { ascending: true })
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read posted runs (${error.code})`);
    runs.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  // 5.7b's correction and one-off runs never take or settle a carried deduction (their payslips
  // carry nothing forward), so they're left out of the running balance; a final-pay or
  // missed-worker run takes it, as a regular run does.
  const runById = new Map(
    runs
      .filter(
        (r) =>
          r.kind !== "off_cycle" ||
          (r.off_cycle_reason !== "correction" && r.off_cycle_reason !== "one_off"),
      )
      .map((r) => [r.id, r] as const),
  );
  const runIds = [...runById.keys()];
  const notCarried = await loadNotCarried(supabase, organisationId);
  if (runIds.length === 0) return { workers: [], outstandingKobo: 0n, notCarried };

  // Workers who ever carried or settled a deduction in a posted run (runs in chunks, rows paged).
  const workerIds = new Set<string>();
  const settlingSlips = new Set<string>();
  for (let i = 0; i < runIds.length; i += CHUNK) {
    const chunk = runIds.slice(i, i + CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("payslips")
        .select("id, worker_id")
        .eq("organisation_id", organisationId)
        .in("run_id", chunk)
        .gt("carried_forward_kobo", 0)
        .order("id")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`Could not read carried deductions (${error.code})`);
      for (const c of data ?? []) workerIds.add(c.worker_id);
      if ((data ?? []).length < PAGE) break;
    }
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("payslip_lines")
        .select("id, payslip_id")
        .eq("organisation_id", organisationId)
        .in("run_id", chunk)
        .eq("code", "carried_deduction")
        .order("id")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`Could not read carried deductions (${error.code})`);
      for (const l of data ?? []) settlingSlips.add(l.payslip_id);
      if ((data ?? []).length < PAGE) break;
    }
  }
  const settling = [...settlingSlips];
  for (let i = 0; i < settling.length; i += CHUNK) {
    const { data, error: e } = await supabase
      .from("payslips")
      .select("worker_id")
      .eq("organisation_id", organisationId)
      .in("id", settling.slice(i, i + CHUNK));
    if (e) throw new Error(`Could not read carried deductions (${e.code})`);
    for (const s of data ?? []) workerIds.add(s.worker_id);
  }
  if (workerIds.size === 0) return { workers: [], outstandingKobo: 0n, notCarried };

  // Every posted payslip of those workers, with what it settled.
  const ids = [...workerIds];
  const slips: CarriedSlip[] = [];
  const names = new Map<string, { name: string; staffId: string }>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    // Their payslips of every run, paged; only posted runs' count (filtered by runById below).
    const rows: { id: string; worker_id: string; run_id: string; carried_forward_kobo: string }[] =
      [];
    for (let from = 0; ; from += PAGE) {
      const { data, error: e } = await supabase
        .from("payslips")
        .select("id, worker_id, run_id, carried_forward_kobo::text")
        .eq("organisation_id", organisationId)
        .in("worker_id", chunk)
        .order("id")
        .range(from, from + PAGE - 1);
      if (e) throw new Error(`Could not read payslips (${e.code})`);
      const page = (data ?? []) as unknown as typeof rows;
      rows.push(...page.filter((r) => runById.has(r.run_id)));
      if (page.length < PAGE) break;
    }
    const slipIds = rows.map((r) => r.id);
    const settled = new Map<string, Kobo>();
    for (let j = 0; j < slipIds.length; j += CHUNK) {
      const { data: lines, error: le } = await supabase
        .from("payslip_lines")
        .select("payslip_id, amount_kobo::text")
        .eq("organisation_id", organisationId)
        .eq("code", "carried_deduction")
        .in("payslip_id", slipIds.slice(j, j + CHUNK));
      if (le) throw new Error(`Could not read payslip lines (${le.code})`);
      for (const l of lines ?? []) {
        settled.set(l.payslip_id, (settled.get(l.payslip_id) ?? 0n) + toKobo(l.amount_kobo));
      }
    }
    for (const r of rows) {
      const run = runById.get(r.run_id);
      if (!run) continue;
      slips.push({
        workerId: r.worker_id,
        runId: r.run_id,
        periodStart: run.period_start,
        periodEnd: run.period_end,
        payDate: run.pay_date,
        approvedAt: run.approved_at ?? "",
        settledKobo: settled.get(r.id) ?? 0n,
        carriedForwardKobo: toKobo(r.carried_forward_kobo),
      });
    }
    const { data: people, error: pe } = await supabase
      .from("workers")
      .select("id, first_name, last_name, staff_id")
      .eq("organisation_id", organisationId)
      .in("id", chunk);
    if (pe) throw new Error(`Could not read workers (${pe.code})`);
    for (const p of people ?? []) {
      names.set(p.id, { name: `${p.first_name} ${p.last_name}`.trim(), staffId: p.staff_id });
    }
  }

  const ledgers = carriedLedgers(slips);
  return {
    workers: ledgers.map((l) => ({
      ...l,
      workerName: names.get(l.workerId)?.name ?? "A worker",
      staffId: names.get(l.workerId)?.staffId ?? "",
    })),
    outstandingKobo: carriedOutstanding(ledgers),
    notCarried,
  };
}

/** 5.7b's `payroll.instalment_not_carried` events, with the workers' names. */
async function loadNotCarried(
  supabase: Client,
  organisationId: string,
): Promise<InstalmentNotCarried[]> {
  const { data, error } = await supabase.rpc("payroll_instalments_not_carried", {
    p_organisation_id: organisationId,
  });
  // A reader without payroll access gets nothing here, as the RLS reads above give nothing.
  if (error) {
    if (error.code === "42501") return [];
    throw new Error(`Could not read instalments not carried (${error.code})`);
  }
  const rows = data ?? [];
  if (rows.length === 0) return [];
  const { data: people, error: pe } = await supabase
    .from("workers")
    .select("id, first_name, last_name")
    .eq("organisation_id", organisationId)
    .in("id", [...new Set(rows.map((r) => r.worker_id))]);
  if (pe) throw new Error(`Could not read workers (${pe.code})`);
  const names = new Map(
    (people ?? []).map((p) => [p.id, `${p.first_name} ${p.last_name}`.trim()] as const),
  );
  return rows.map((r) => ({
    workerId: r.worker_id,
    workerName: names.get(r.worker_id) ?? "A worker",
    seriesId: r.series_id,
    instalment: r.instalment,
    of: r.of_count,
    amountKobo: toKobo(r.amount_kobo),
    at: r.at,
  }));
}

/** Counts and totals only (no names): the capability registry's read. */
export async function loadCarriedDeductionsSummary(
  supabase: Client,
  organisationId: string,
): Promise<
  { workersOwing: number; workersCarried: number; outstandingKobo: string } | { unavailable: true }
> {
  let data: CarriedDeductions;
  try {
    data = await loadCarriedDeductions(supabase, organisationId);
  } catch (e) {
    console.error("payroll.carried_summary_failed:", e instanceof Error ? e.name : "unknown");
    return { unavailable: true };
  }
  return {
    workersOwing: data.workers.filter((w) => w.balanceKobo > 0n).length,
    workersCarried: data.workers.length,
    outstandingKobo: data.outstandingKobo.toString(),
  };
}
