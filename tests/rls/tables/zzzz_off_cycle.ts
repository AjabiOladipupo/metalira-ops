/**
 * Isolation registry for slice 5.7b (off-cycle runs). Each side's owner creates a one-off
 * off-cycle run for a new worker through create_off_cycle_run, which writes its chosen workers to
 * payroll_run_workers. Signed-in roles have no write grants (the function writes, and the guard
 * fixes the rows at creation), so every attack is 42501.
 *
 * Named to sort after the other payroll registries, whose seeds pick a company's runs by status.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { TableSpec } from "../helpers/registry";
import { addPayrollWorker, OCT_START } from "../helpers/payroll";
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
    table: "payroll_run_workers",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ admin, side }) => {
      const { workerId } = await addPayrollWorker(admin, side.orgId);
      const { error } = await side.client.rpc("create_off_cycle_run", {
        p_organisation_id: side.orgId,
        p_period_start: OCT_START,
        p_pay_date: "2026-10-16",
        p_reason: "one_off",
        p_note: "Isolation seed",
        p_worker_ids: [workerId],
      });
      if (error) throw new Error(`payroll_run_workers: ${error.message}`);
    },
    rowOf: ({ admin, side }) => firstId(admin, "payroll_run_workers", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      run_id: randomUUID(),
      worker_id: randomUUID(),
      created_by: randomUUID(),
    }),
    patch: { worker_id: randomUUID() },
  },
];
