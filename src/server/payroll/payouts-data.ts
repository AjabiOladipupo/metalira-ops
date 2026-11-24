import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { toKobo, type Kobo } from "@/lib/money";
import type { LeftOutReason } from "@/lib/payroll/payout";
import type { Database } from "@/types/db";

/**
 * Reads for the run's Pay step (slice 5.4), under RLS as the signed-in member: owner, hr and
 * finance see a run's bank files (control totals) and items (bank name, code, account name and the
 * last 4 digits only); everyone else gets no rows. Kobo is read as text and becomes `bigint`.
 */

type Client = SupabaseClient<Database>;

export interface PayoutBatchRow {
  id: string;
  status: "active" | "voided";
  bankFormat: string;
  fileSha256: string;
  fileBytes: number;
  itemCount: number;
  totalKobo: Kobo;
  leftOutCount: number;
  leftOutKobo: Kobo;
  madeBy: string;
  createdAt: string;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
}

export interface PayoutItemRow {
  id: string;
  payslipId: string;
  workerId: string;
  workerName: string;
  position: number;
  status: "pending" | "left_out" | "voided";
  leftOutReason: LeftOutReason | null;
  bankName: string | null;
  bankCode: string | null;
  accountName: string | null;
  bankAccountLast4: string | null;
  amountKobo: Kobo;
}

export interface PayoutDetail {
  batches: PayoutBatchRow[];
  active: PayoutBatchRow | null;
  /** The active file's items, in file order. */
  items: PayoutItemRow[];
  /** Managers' names by user id (who made, voided and released). */
  people: Map<string, string>;
}

type BatchRecord = {
  id: string;
  status: string;
  bank_format: string;
  file_sha256: string;
  file_bytes: number;
  item_count: number;
  total_kobo: string;
  left_out_count: number;
  left_out_kobo: string;
  made_by: string;
  created_at: string;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
};

type ItemRecord = {
  id: string;
  payslip_id: string;
  worker_id: string;
  position: number;
  status: string;
  left_out_reason: string | null;
  bank_name: string | null;
  bank_code: string | null;
  account_name: string | null;
  bank_account_last4: string | null;
  amount_kobo: string;
};

const toBatch = (b: BatchRecord): PayoutBatchRow => ({
  id: b.id,
  status: b.status === "voided" ? "voided" : "active",
  bankFormat: b.bank_format,
  fileSha256: b.file_sha256,
  fileBytes: b.file_bytes,
  itemCount: b.item_count,
  totalKobo: toKobo(b.total_kobo),
  leftOutCount: b.left_out_count,
  leftOutKobo: toKobo(b.left_out_kobo),
  madeBy: b.made_by,
  createdAt: b.created_at,
  voidedAt: b.voided_at,
  voidedBy: b.voided_by,
  voidReason: b.void_reason,
});

/** The run's bank files and the active one's items (`workerNames` by worker id, from the run). */
export async function loadPayoutDetail(
  supabase: Client,
  organisationId: string,
  runId: string,
  workerNames: ReadonlyMap<string, string>,
  extraPeople: readonly (string | null)[] = [],
): Promise<PayoutDetail> {
  const { data: batchData, error } = await supabase
    .from("payout_batches")
    .select(
      "id, status, bank_format, file_sha256, file_bytes, item_count, total_kobo::text, left_out_count, left_out_kobo::text, made_by, created_at, voided_at, voided_by, void_reason",
    )
    .eq("organisation_id", organisationId)
    .eq("run_id", runId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`Could not read the bank files (${error.code})`);
  const batches = ((batchData ?? []) as unknown as BatchRecord[]).map(toBatch);
  const active = batches.find((b) => b.status === "active") ?? null;

  let items: PayoutItemRow[] = [];
  if (active) {
    const { data: itemData, error: itemError } = await supabase
      .from("payout_items")
      .select(
        "id, payslip_id, worker_id, position, status, left_out_reason, bank_name, bank_code, account_name, bank_account_last4, amount_kobo::text",
      )
      .eq("organisation_id", organisationId)
      .eq("batch_id", active.id)
      .order("position", { ascending: true })
      .limit(5000);
    if (itemError) throw new Error(`Could not read the bank file items (${itemError.code})`);
    items = ((itemData ?? []) as unknown as ItemRecord[]).map((i) => ({
      id: i.id,
      payslipId: i.payslip_id,
      workerId: i.worker_id,
      workerName: workerNames.get(i.worker_id) ?? "A worker",
      position: i.position,
      status: i.status as PayoutItemRow["status"],
      leftOutReason: i.left_out_reason as LeftOutReason | null,
      bankName: i.bank_name,
      bankCode: i.bank_code,
      accountName: i.account_name,
      bankAccountLast4: i.bank_account_last4,
      amountKobo: toKobo(i.amount_kobo),
    }));
  }

  const ids = [
    ...new Set(
      [...batches.flatMap((b) => [b.madeBy, b.voidedBy]), ...extraPeople].filter(
        (id): id is string => typeof id === "string",
      ),
    ),
  ];
  const people = new Map<string, string>();
  if (ids.length > 0) {
    const { data } = await supabase
      .from("profiles")
      .select("user_id, full_name")
      .in("user_id", ids);
    for (const p of data ?? []) if (p.full_name) people.set(p.user_id, p.full_name);
  }
  return { batches, active, items, people };
}

/** Counts and totals only (no names, no bank details): the capability registry's read. */
export async function loadPayoutSummary(
  supabase: Client,
  organisationId: string,
): Promise<{
  runs: number;
  latest: {
    periodStart: string;
    periodEnd: string;
    status: string;
    bankFile: null | { workers: number; totalKobo: string; leftOut: number; madeAt: string };
  } | null;
}> {
  const { data: runs, error } = await supabase
    .from("payroll_runs")
    .select("id, period_start, period_end, status")
    .eq("organisation_id", organisationId)
    .in("status", ["approved", "released"])
    .neq("kind", "reversal")
    .order("period_start", { ascending: false })
    .limit(24);
  if (error) throw new Error(`Could not read payroll runs (${error.code})`);
  const latest = runs?.[0];
  if (!latest) return { runs: 0, latest: null };
  const { data: batch, error: batchError } = await supabase
    .from("payout_batches")
    .select("item_count, total_kobo::text, left_out_count, created_at")
    .eq("organisation_id", organisationId)
    .eq("run_id", latest.id)
    .eq("status", "active")
    .maybeSingle();
  if (batchError) throw new Error(`Could not read the bank file (${batchError.code})`);
  const b = batch as unknown as {
    item_count: number;
    total_kobo: string;
    left_out_count: number;
    created_at: string;
  } | null;
  return {
    runs: runs.length,
    latest: {
      periodStart: latest.period_start,
      periodEnd: latest.period_end,
      status: latest.status,
      bankFile: b
        ? {
            workers: b.item_count,
            totalKobo: b.total_kobo,
            leftOut: b.left_out_count,
            madeAt: b.created_at,
          }
        : null,
    },
  };
}
