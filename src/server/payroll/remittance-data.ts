import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { toKobo, type Kobo } from "@/lib/money";
import {
  remittanceStatus,
  type RemitDueDays,
  type RemittanceKind,
  type RemittanceStatus,
} from "@/lib/payroll/statutory";
import type { Database } from "@/types/db";

/**
 * Reads for statutory remittances (slice 5.6), under RLS as the signed-in member: owner, hr and
 * finance see a company's remittances, payments and receipts; everyone else gets no rows. Kobo is
 * read as text and turned into `bigint`. Status (due, overdue, paid) is worked out on read.
 */

type Client = SupabaseClient<Database>;

export interface RemittancePayment {
  id: string;
  paidOn: string;
  paidAmountKobo: Kobo;
  reference: string | null;
  receiptId: string;
  receiptExt: string | null;
  recordedBy: string;
  recordedByName: string;
  recordedAt: string;
}

export interface RemittanceVoid {
  paymentId: string;
  reason: string;
  voidedByName: string;
  voidedAt: string;
}

export interface RemittanceRow {
  id: string;
  runId: string;
  kind: RemittanceKind;
  authorityKey: string | null;
  amountKobo: Kobo;
  workerCount: number;
  dueDate: string | null;
  status: RemittanceStatus;
  /** The standing payment, if one is recorded. */
  payment: RemittancePayment | null;
  /** Payments recorded before and voided, newest first. */
  voided: (RemittancePayment & { void: RemittanceVoid })[];
}

export interface RemittanceRun {
  id: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  status: string;
  remittances: RemittanceRow[];
}

type RemittanceRecord = {
  id: string;
  run_id: string;
  kind: string;
  authority_key: string | null;
  amount_kobo: string;
  worker_count: number;
  due_date: string | null;
};

type PaymentRecord = {
  id: string;
  remittance_id: string;
  entry: string;
  paid_on: string | null;
  paid_amount_kobo: string | null;
  reference: string | null;
  receipt_id: string | null;
  voids_payment_id: string | null;
  reason: string | null;
  recorded_by: string;
  created_at: string;
};

async function profileNames(
  supabase: Client,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const names = new Map<string, string>();
  if (unique.length === 0) return names;
  const { data } = await supabase
    .from("profiles")
    .select("user_id, full_name")
    .in("user_id", unique);
  for (const p of data ?? []) if (p.full_name) names.set(p.user_id, p.full_name);
  return names;
}

const KIND_ORDER: readonly string[] = ["paye", "pension", "nhf", "nsitf", "itf"];

/**
 * The company's posted runs with their remittances, newest period first (12 runs at most, or the
 * one run asked for). A run the caller can't read gives nothing.
 */
export async function loadRemittances(
  supabase: Client,
  organisationId: string,
  today: string,
  options: { runId?: string } = {},
): Promise<RemittanceRun[]> {
  let runQuery = supabase
    .from("payroll_runs")
    .select("id, period_start, period_end, pay_date, status")
    .eq("organisation_id", organisationId)
    .in("status", ["approved", "released"])
    .order("period_start", { ascending: false })
    .limit(12);
  if (options.runId) runQuery = runQuery.eq("id", options.runId);
  const { data: runs, error: runError } = await runQuery;
  if (runError) throw new Error(`Could not read payroll runs (${runError.code})`);
  if (!runs || runs.length === 0) return [];
  const runIds = runs.map((r) => r.id);

  const { data: rems, error: remError } = await supabase
    .from("statutory_remittances")
    .select("id, run_id, kind, authority_key, amount_kobo::text, worker_count, due_date")
    .eq("organisation_id", organisationId)
    .in("run_id", runIds);
  if (remError) throw new Error(`Could not read remittances (${remError.code})`);
  const remRows = (rems ?? []) as unknown as RemittanceRecord[];
  const remIds = remRows.map((r) => r.id);

  const payRows: PaymentRecord[] = [];
  const receiptExt = new Map<string, string>();
  if (remIds.length > 0) {
    const { data: pays, error: payError } = await supabase
      .from("statutory_payments")
      .select(
        "id, remittance_id, entry, paid_on, paid_amount_kobo::text, reference, receipt_id, voids_payment_id, reason, recorded_by, created_at",
      )
      .eq("organisation_id", organisationId)
      .in("remittance_id", remIds)
      .order("created_at", { ascending: false });
    if (payError) throw new Error(`Could not read remittance payments (${payError.code})`);
    payRows.push(...((pays ?? []) as unknown as PaymentRecord[]));
    const receiptIds = payRows.flatMap((p) => (p.receipt_id ? [p.receipt_id] : []));
    if (receiptIds.length > 0) {
      const { data: receipts, error: receiptError } = await supabase
        .from("statutory_receipts")
        .select("id, file_ext")
        .eq("organisation_id", organisationId)
        .in("id", receiptIds);
      if (receiptError) throw new Error(`Could not read receipts (${receiptError.code})`);
      for (const r of receipts ?? []) receiptExt.set(r.id, r.file_ext);
    }
  }
  const names = await profileNames(
    supabase,
    payRows.map((p) => p.recorded_by),
  );
  const nameOf = (id: string) => names.get(id) ?? "A manager";
  const voids = new Map(
    payRows
      .filter((p) => p.entry === "void" && p.voids_payment_id)
      .map((v) => [v.voids_payment_id!, v]),
  );
  const toPayment = (p: PaymentRecord): RemittancePayment => ({
    id: p.id,
    paidOn: p.paid_on ?? "",
    paidAmountKobo: toKobo(p.paid_amount_kobo ?? "0"),
    reference: p.reference,
    receiptId: p.receipt_id ?? "",
    receiptExt: p.receipt_id ? (receiptExt.get(p.receipt_id) ?? null) : null,
    recordedBy: p.recorded_by,
    recordedByName: nameOf(p.recorded_by),
    recordedAt: p.created_at,
  });

  const byRun = new Map<string, RemittanceRow[]>();
  for (const r of remRows) {
    const payments = payRows.filter((p) => p.remittance_id === r.id && p.entry === "payment");
    const standing = payments.find((p) => !voids.has(p.id)) ?? null;
    const row: RemittanceRow = {
      id: r.id,
      runId: r.run_id,
      kind: r.kind as RemittanceKind,
      authorityKey: r.authority_key,
      amountKobo: toKobo(r.amount_kobo),
      workerCount: r.worker_count,
      dueDate: r.due_date,
      status: remittanceStatus({ dueDate: r.due_date, paid: standing !== null }, today),
      payment: standing ? toPayment(standing) : null,
      voided: payments
        .filter((p) => voids.has(p.id))
        .map((p) => {
          const v = voids.get(p.id)!;
          return {
            ...toPayment(p),
            void: {
              paymentId: p.id,
              reason: v.reason ?? "",
              voidedByName: nameOf(v.recorded_by),
              voidedAt: v.created_at,
            },
          };
        }),
    };
    byRun.set(r.run_id, [...(byRun.get(r.run_id) ?? []), row]);
  }
  return runs.map((run) => ({
    id: run.id,
    periodStart: run.period_start,
    periodEnd: run.period_end,
    payDate: run.pay_date,
    status: run.status,
    remittances: (byRun.get(run.id) ?? []).sort((a, b) => {
      const k = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
      if (k !== 0) return k;
      return (a.authorityKey ?? "").localeCompare(b.authorityKey ?? "");
    }),
  }));
}

/** One remittance with its run, read as the caller (null when it isn't theirs to read). */
export async function loadRemittance(
  supabase: Client,
  organisationId: string,
  remittanceId: string,
  today: string,
): Promise<{ run: RemittanceRun; remittance: RemittanceRow } | null> {
  const { data, error } = await supabase
    .from("statutory_remittances")
    .select("run_id")
    .eq("organisation_id", organisationId)
    .eq("id", remittanceId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the remittance (${error.code})`);
  if (!data) return null;
  const [run] = await loadRemittances(supabase, organisationId, today, { runId: data.run_id });
  const remittance = run?.remittances.find((r) => r.id === remittanceId);
  return run && remittance ? { run, remittance } : null;
}

/** The company's own remittance due days (open question 13). */
export async function loadRemitDueDays(
  supabase: Client,
  organisationId: string,
): Promise<RemitDueDays> {
  const { data, error } = await supabase
    .from("organisations")
    .select("paye_remit_day, nhf_remit_day, nsitf_remit_day, itf_remit_day")
    .eq("id", organisationId)
    .maybeSingle();
  if (error) throw new Error(`Could not read payroll settings (${error.code})`);
  return {
    paye: data?.paye_remit_day ?? null,
    nhf: data?.nhf_remit_day ?? null,
    nsitf: data?.nsitf_remit_day ?? null,
    itf: data?.itf_remit_day ?? null,
  };
}

export interface RemittanceSummary {
  remittances: number;
  paid: number;
  due: number;
  overdue: number;
  noDueDate: number;
  /** Owed and not yet paid, in kobo as a string. */
  outstandingKobo: string;
  nextDueDate: string | null;
}

/** Counts and totals only (no names, no references): the capability registry's read. */
export async function loadRemittanceSummary(
  supabase: Client,
  organisationId: string,
  today: string,
): Promise<RemittanceSummary> {
  const runs = await loadRemittances(supabase, organisationId, today);
  const all = runs.flatMap((r) => r.remittances);
  const open = all.filter((r) => r.status !== "paid");
  const dues = open.flatMap((r) => (r.dueDate ? [r.dueDate] : [])).sort();
  return {
    remittances: all.length,
    paid: all.length - open.length,
    due: open.filter((r) => r.status === "due").length,
    overdue: open.filter((r) => r.status === "overdue").length,
    noDueDate: open.filter((r) => r.status === "no_due_date").length,
    outstandingKobo: open.reduce((n, r) => n + r.amountKobo, 0n).toString(),
    nextDueDate: dues[0] ?? null,
  };
}
