/**
 * Isolation registry for slice 5.6 (statutory remittances). zz_payroll_runs.ts seeds a submitted
 * October run per side; here a second person in Finance approves it, which makes its remittances
 * (statutory_remittances), then a receipt is put in the payroll-evidence bucket and recorded with
 * the secret key (statutory_receipts) and Finance records the PAYE payment (statutory_payments).
 * Signed-in roles have no write grants on any of them (the functions write), so every attack is
 * refused. Finance's membership is removed again after seeding, so the company's only member
 * stays its owner (isolation.test.ts checks that).
 *
 * Named to sort after zz_payroll_runs.ts, whose run in review it approves.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { TableSpec } from "../helpers/registry";
import { SHA } from "../helpers/payroll";
import { addFinance, approveRun, seedReceipt } from "../helpers/statutory";
import type { Client } from "../helpers/supabase";

async function firstId(admin: Client, table: string, orgId: string): Promise<string> {
  const { data, error } = await (admin as unknown as SupabaseClient)
    .from(table)
    .select("id")
    .eq("organisation_id", orgId)
    .limit(1)
    .single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data as { id: string }).id;
}

const spec = (
  table: string,
  attack: (orgId: string) => Record<string, unknown>,
  patch: Record<string, unknown>,
  seed?: TableSpec["seed"],
): TableSpec => ({
  table,
  key: "id",
  tenantColumn: "organisation_id",
  tenantValue: (side) => side.orgId,
  ...(seed ? { seed } : {}),
  rowOf: ({ admin, side }) => firstId(admin, table, side.orgId),
  attackInsert: ({ victim }) => attack(victim.orgId),
  patch,
});

export const tables: TableSpec[] = [
  spec(
    "statutory_remittances",
    (orgId) => ({
      organisation_id: orgId,
      run_id: randomUUID(),
      kind: "nsitf",
      amount_kobo: 1,
      worker_count: 1,
    }),
    { due_date: "2030-01-01" },
    async ({ admin, side }) => {
      // zz_payroll_runs.ts's October run, still in review (5.5's seed adds a released June run).
      const { data: run, error: runError } = await admin
        .from("payroll_runs")
        .select("id")
        .eq("organisation_id", side.orgId)
        .eq("status", "review")
        .single();
      if (runError) throw new Error(`payroll_runs: ${runError.message}`);
      const runId = run.id;
      const finance = await addFinance(admin, side.orgId, "iso-stat-fin");
      await approveRun(admin, side.orgId, runId, finance);
      const { data: paye, error } = await admin
        .from("statutory_remittances")
        .select("id")
        .eq("organisation_id", side.orgId)
        .eq("run_id", runId)
        .eq("kind", "paye")
        .single();
      if (error) throw new Error(`statutory_remittances: ${error.message}`);
      const receipt = await seedReceipt(admin, side.orgId, paye.id, finance.id);
      if (receipt.error) throw new Error(`statutory_receipts: ${receipt.error.code}`);
      const paid = await finance.client.rpc("record_statutory_payment", {
        p_organisation_id: side.orgId,
        p_remittance_id: paye.id,
        p_receipt_id: receipt.receiptId,
        p_paid_on: "2026-10-26",
        p_paid_amount_kobo: "100000",
        p_reference: "LIRS-ISO",
      });
      if (paid.error) throw new Error(`statutory_payments: ${paid.error.message}`);
      // isolation.test.ts expects each company's only member to be its owner: Finance leaves
      // once the rows are made (the rows keep who acted).
      const left = await admin
        .from("memberships")
        .delete()
        .eq("organisation_id", side.orgId)
        .eq("user_id", finance.id);
      if (left.error) throw new Error(`memberships: ${left.error.message}`);
    },
  ),
  spec(
    "statutory_receipts",
    (orgId) => ({
      id: randomUUID(),
      organisation_id: orgId,
      remittance_id: randomUUID(),
      file_ext: "pdf",
      mime_type: "application/pdf",
      size_bytes: 10,
      sha256: SHA,
      storage_path: `${orgId}/x/y.pdf`,
      checked_by: randomUUID(),
    }),
    { sha256: "b".repeat(64) },
  ),
  spec(
    "statutory_payments",
    (orgId) => ({
      organisation_id: orgId,
      remittance_id: randomUUID(),
      entry: "payment",
      paid_on: "2026-10-26",
      paid_amount_kobo: 1,
      receipt_id: randomUUID(),
      recorded_by: randomUUID(),
    }),
    { reference: "Changed" },
  ),
];
