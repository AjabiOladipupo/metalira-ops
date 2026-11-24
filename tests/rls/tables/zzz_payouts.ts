/**
 * Isolation registry for slice 5.4 (the bank file). Each side's October run (seeded by
 * zz_payroll_runs.ts, submitted by the side's owner, and approved by a Finance member in
 * zz_statutory.ts) gets bank details for its worker (the secret key), and the side's owner makes
 * the bank file through the server's two steps (the file stored with the secret key, then
 * make_payout_batch as the owner, who may make a file for a run they prepared). Signed-in roles
 * have no write grants on either table, so every attack is 42501.
 *
 * Named to sort after zz_payroll_runs.ts and zz_statutory.ts, whose seeds make and approve the run.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { TableSpec } from "../helpers/registry";
import { giveBankDetails, makeBatch } from "../helpers/payout";
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

export const tables: TableSpec[] = [
  {
    table: "payout_batches",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ admin, side }) => {
      // The October run (zz_payslip_documents.ts releases a run of its own; this one is approved).
      const { data: run, error: runError } = await admin
        .from("payroll_runs")
        .select("id")
        .eq("organisation_id", side.orgId)
        .eq("status", "approved")
        .limit(1)
        .single();
      if (runError) throw new Error(`payout_batches: ${runError.message}`);
      const runId = run.id;
      const { data: slip, error } = await admin
        .from("payslips")
        .select("worker_id")
        .eq("run_id", runId)
        .limit(1)
        .single();
      if (error) throw new Error(`payout_batches: ${error.message}`);
      await giveBankDetails(admin, side.orgId, slip.worker_id);
      const made = await makeBatch(admin, side.client, side.orgId, runId);
      if (made.error) throw new Error(`payout_batches: ${made.error.message}`);
    },
    rowOf: ({ admin, side }) => firstId(admin, "payout_batches", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      run_id: randomUUID(),
      bank_format: "generic-csv",
      file_path: `${victim.orgId}/x.csv`,
      file_sha256: "c".repeat(64),
      file_bytes: 1,
      item_count: 1,
      total_kobo: 1,
      left_out_count: 0,
      left_out_kobo: 0,
      made_by: randomUUID(),
    }),
    patch: { void_reason: "Changed" },
  },
  {
    table: "payout_items",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    rowOf: ({ admin, side }) => firstId(admin, "payout_items", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      batch_id: randomUUID(),
      run_id: randomUUID(),
      payslip_id: randomUUID(),
      worker_id: randomUUID(),
      position: 1,
      status: "left_out",
      left_out_reason: "nothing_to_pay",
      amount_kobo: 0,
    }),
    patch: { amount_kobo: 1 },
  },
];
