/**
 * Isolation registry for slice 5.7a (payroll reversal). Each side's October run (seeded by
 * zz_payroll_runs.ts, approved in zz_statutory.ts, given a bank file in zzz_payouts.ts) is
 * reversed: the side's owner asks for the reversal and a Finance member approves it, which voids
 * the run's remittances (statutory_remittance_voids). Signed-in roles have no write grants on the
 * table (approve_payroll_reversal writes), so every attack is refused. Finance's membership is
 * removed again after seeding, so the company's only member stays its owner (isolation.test.ts
 * checks that).
 *
 * Named to sort after zzz_payouts.ts, whose bank file the reversal voids.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { TableSpec } from "../helpers/registry";
import { addFinance } from "../helpers/statutory";
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
    table: "statutory_remittance_voids",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ admin, side }) => {
      const { data: run, error: runError } = await admin
        .from("payroll_runs")
        .select("id")
        .eq("organisation_id", side.orgId)
        .eq("kind", "regular")
        .eq("status", "approved")
        .limit(1)
        .single();
      if (runError) throw new Error(`statutory_remittance_voids: ${runError.message}`);
      const asked = await side.client.rpc("reverse_payroll_run", {
        p_organisation_id: side.orgId,
        p_run_id: run.id,
        p_reason: "Isolation seed",
        p_not_uploaded: true,
      });
      if (asked.error) throw new Error(`reverse_payroll_run: ${asked.error.message}`);
      const finance = await addFinance(admin, side.orgId, "iso-rev-fin");
      const approved = await finance.client.rpc("approve_payroll_reversal", {
        p_organisation_id: side.orgId,
        p_run_id: asked.data!,
        p_not_uploaded: true,
      });
      if (approved.error) throw new Error(`approve_payroll_reversal: ${approved.error.message}`);
      const left = await admin
        .from("memberships")
        .delete()
        .eq("organisation_id", side.orgId)
        .eq("user_id", finance.id);
      if (left.error) throw new Error(`memberships: ${left.error.message}`);
    },
    rowOf: ({ admin, side }) => firstId(admin, "statutory_remittance_voids", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      remittance_id: randomUUID(),
      run_id: randomUUID(),
      reason: "Forged",
      voided_by: randomUUID(),
    }),
    patch: { reason: "Changed" },
  },
];
