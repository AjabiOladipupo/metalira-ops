/**
 * Isolation registry for slice 5.9c: the company's holiday pay multiplier and leavers' final-pay
 * items. Each side's owner adds a holiday pay rate from the day after tomorrow, and a gratuity on
 * a final-pay off-cycle run for a new leaver, through the definer functions. Signed-in roles
 * have no write grants (the functions write; guards keep rows as written), so every attack is
 * 42501.
 *
 * Named to sort after the other payroll registries, whose seeds pick a company's runs by status.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { addDays, lagosToday } from "@/lib/dates";

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
    table: "payroll_holiday_pay_rates",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ side }) => {
      const { error } = await side.client.rpc("set_holiday_pay_multiplier", {
        p_organisation_id: side.orgId,
        p_multiplier_bps: 15_000,
        p_effective_from: addDays(lagosToday(), 2),
        p_reason: "Isolation seed",
      });
      if (error) throw new Error(`payroll_holiday_pay_rates: ${error.message}`);
    },
    rowOf: ({ admin, side }) => firstId(admin, "payroll_holiday_pay_rates", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      effective_from: addDays(lagosToday(), 30),
      multiplier_bps: 20_000,
      reason: "Attack",
      created_by: randomUUID(),
    }),
    patch: { multiplier_bps: 50_000 },
  },
  {
    table: "payroll_final_pay_items",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ admin, side }) => {
      const { workerId } = await addPayrollWorker(admin, side.orgId, { end_date: "2026-10-05" });
      const run = await side.client.rpc("create_off_cycle_run", {
        p_organisation_id: side.orgId,
        p_period_start: OCT_START,
        p_pay_date: "2026-10-16",
        p_reason: "final_pay",
        p_note: "Isolation seed",
        p_worker_ids: [workerId],
      });
      if (run.error) throw new Error(`payroll_final_pay_items: ${run.error.message}`);
      const { error } = await side.client.rpc("add_final_pay_item", {
        p_organisation_id: side.orgId,
        p_run_id: run.data!,
        p_worker_id: workerId,
        p_item_type: "gratuity",
        p_amount_kobo: "5000000",
        p_reason: "Isolation seed",
      });
      if (error) throw new Error(`payroll_final_pay_items: ${error.message}`);
    },
    rowOf: ({ admin, side }) => firstId(admin, "payroll_final_pay_items", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      run_id: randomUUID(),
      worker_id: randomUUID(),
      item_type: "gratuity",
      amount_kobo: 100,
      reason: "Attack",
      created_by: randomUUID(),
    }),
    patch: { amount_kobo: 200 },
  },
];
