/**
 * Isolation registry for slice 5.4 (the bank file). Each side's October run (seeded by
 * zz_payroll_runs.ts, submitted by the side's owner) is approved by a Finance member added here
 * after the server's input check, its worker gets bank details (the secret key), and Finance makes
 * the bank file through the server's two steps (the file stored with the secret key, then
 * make_payout_batch as Finance); the Finance membership is then removed again. Signed-in roles have no write grants on either table, so every
 * attack is 42501.
 *
 * Named to sort after zz_payroll_runs.ts, whose seed makes the run.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { TableSpec } from "../helpers/registry";
import { approveRun, giveBankDetails, makeBatch } from "../helpers/payout";
import { createTestUser, type Client } from "../helpers/supabase";

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
      const runId = await firstId(admin, "payroll_runs", side.orgId);
      const { data: slip, error } = await admin
        .from("payslips")
        .select("worker_id")
        .eq("run_id", runId)
        .limit(1)
        .single();
      if (error) throw new Error(`payout_batches: ${error.message}`);
      await giveBankDetails(admin, side.orgId, slip.worker_id);
      const finance = await createTestUser(`iso-payout-fin-${side.orgId.slice(0, 8)}`);
      const member = await admin
        .from("memberships")
        .insert({ organisation_id: side.orgId, user_id: finance.id, role: "finance" });
      if (member.error) throw new Error(`payout_batches: ${member.error.message}`);
      await approveRun(admin, side.orgId, runId, finance);
      const made = await makeBatch(admin, finance.client, side.orgId, runId);
      if (made.error) throw new Error(`payout_batches: ${made.error.message}`);
      // The membership checks expect only the side's owner in its company.
      const removed = await admin
        .from("memberships")
        .delete()
        .eq("organisation_id", side.orgId)
        .eq("user_id", finance.id);
      if (removed.error) throw new Error(`payout_batches: ${removed.error.message}`);
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
