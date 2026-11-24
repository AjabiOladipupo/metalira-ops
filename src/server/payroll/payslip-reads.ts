import "server-only";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import { PAYROLL_READERS } from "@/lib/pay-access";
import { parsePayslipViews, type PayslipView } from "@/lib/payroll/payslip-view";
import type { ManagerRole } from "@/lib/roles";
import type { Database } from "@/types/db";

/**
 * Payslip reads with the signed-in user's own client (slice 5.5): the worker's own released
 * payslips (my_payslips) and, for owner, hr and finance, each payslip of a run with its PDF and
 * notice (RLS). No secret key here: pages import this module, never the publishing one.
 */

type Client = SupabaseClient<Database>;
const PAGE = 1000;

/** Who opens any payslip's PDF on the manager side. */
export const PAYSLIP_READERS = PAYROLL_READERS;
/** Who may finish publishing a released run's payslips (those who release: owner, finance). */
export const PAYSLIP_PUBLISHERS = ["owner", "finance"] as const satisfies readonly ManagerRole[];

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function allRows<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: PostgrestError | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read payslips (${error.code})`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

// ---------------------------------------------------------------------------

/** The signed-in worker's released payslips, newest first (my_payslips, their own client). */
export async function loadMyPayslips(
  supabase: Client,
  organisationId: string,
): Promise<PayslipView[]> {
  const { data, error } = await supabase.rpc("my_payslips", { p_organisation_id: organisationId });
  if (error) throw new Error(`Could not read payslips (${error.code})`);
  return parsePayslipViews(data);
}

export interface RunPayslipDocument {
  payslipId: string;
  /** The newest PDF's id and when it was made, or null when none is made yet. */
  documentId: string | null;
  madeAt: string | null;
  /** Whether the worker has the release notice; null when the reader can't see inboxes. */
  notified: boolean | null;
}

/**
 * Each payslip of a run with its PDF and notice, for owner, hr and finance (RLS): finance reads
 * no inboxes, so `notified` is null for them.
 */
export async function loadRunPayslipDocuments(
  supabase: Client,
  organisationId: string,
  runId: string,
  payslipIds: readonly string[],
  options: { canSeeNotices: boolean },
): Promise<Map<string, RunPayslipDocument>> {
  const docs = await allRows<{ id: string; payslip_id: string; made_at: string }>((from, to) =>
    supabase
      .from("payslip_documents")
      .select("id, payslip_id, made_at")
      .eq("organisation_id", organisationId)
      .eq("run_id", runId)
      .order("made_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to),
  );
  const notified = new Set<string>();
  if (options.canSeeNotices) {
    for (const part of chunks(payslipIds, 100)) {
      const { data, error } = await supabase
        .from("inbox_items")
        .select("payslip_id")
        .eq("organisation_id", organisationId)
        .in("payslip_id", part);
      if (error) throw new Error(`Could not read notices (${error.code})`);
      for (const row of data ?? []) if (row.payslip_id) notified.add(row.payslip_id);
    }
  }
  const out = new Map<string, RunPayslipDocument>();
  for (const id of payslipIds) {
    const doc = docs.find((d) => d.payslip_id === id) ?? null;
    out.set(id, {
      payslipId: id,
      documentId: doc?.id ?? null,
      madeAt: doc?.made_at ?? null,
      notified: options.canSeeNotices ? notified.has(id) : null,
    });
  }
  return out;
}
