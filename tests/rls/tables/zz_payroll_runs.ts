/**
 * Isolation registry for slice 5.2 (the payroll run) and 5.3 (approval). One October run per side
 * is made through the functions (create, an allowance, results saved with the secret key, the
 * anomaly acknowledged, submitted), which fills seven tables: payroll_runs, payslips,
 * payslip_lines, payslip_sources, payroll_adjustments, payroll_anomalies and
 * payroll_run_decisions; the server's input check before approval (record_payroll_approval_check,
 * the secret key) fills payroll_approval_checks. Signed-in roles have no write grants on any of
 * them (the functions write), so every attack is 42501.
 *
 * Named to sort last: its seed adds a worker, and earlier seeds pick a company's first worker
 * (`firstId(admin, "workers", ...)` in people.ts) for rows that must match their own worker.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { TableSpec } from "../helpers/registry";
import { OCT_END, OCT_START, seedPayrollRun, SHA } from "../helpers/payroll";
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
    "payroll_runs",
    (orgId) => ({
      organisation_id: orgId,
      period_start: "2027-01-20",
      period_end: "2027-02-19",
      pay_date: "2027-02-25",
      rule_set_id: randomUUID(),
      prepared_by: randomUUID(),
    }),
    { needs_recalculation: true },
    async ({ admin, side }) => {
      await seedPayrollRun(admin, side, { submit: true });
    },
  ),
  spec(
    "payslips",
    (orgId) => ({
      organisation_id: orgId,
      run_id: randomUUID(),
      worker_id: randomUUID(),
      gross_kobo: 1,
      paye_kobo: 0,
      pension_employee_kobo: 0,
      pension_employer_kobo: 0,
      nhf_kobo: 0,
      other_deductions_kobo: 0,
      net_kobo: 1,
      carried_forward_kobo: 0,
      nsitf_kobo: 0,
      itf_kobo: 0,
      employer_cost_kobo: 1,
      rule_set_id: randomUUID(),
      employment_type: "permanent",
      cycle_days: 30,
      rostered_days: 21,
      employed_rostered_days: 21,
      leave_deducted_days: 0,
      trace: { trace_version: 1, steps: [] },
      trace_version: 1,
    }),
    { net_kobo: 999 },
  ),
  spec(
    "payslip_lines",
    (orgId) => ({
      organisation_id: orgId,
      payslip_id: randomUUID(),
      run_id: randomUUID(),
      position: 99,
      code: "basic",
      kind: "earning",
      label: "Attack",
      amount_kobo: 1,
      pensionable: true,
      taxable: true,
    }),
    { amount_kobo: 999 },
  ),
  spec(
    "payslip_sources",
    (orgId) => ({
      organisation_id: orgId,
      payslip_id: randomUUID(),
      run_id: randomUUID(),
      worker_id: randomUUID(),
      source_kind: "adjustment",
      source_id: randomUUID(),
      from_date: OCT_START,
      to_date: OCT_END,
      line_positions: [1],
    }),
    { stands: false },
  ),
  spec(
    "payroll_adjustments",
    (orgId) => ({
      organisation_id: orgId,
      run_id: randomUUID(),
      worker_id: randomUUID(),
      kind: "earning",
      label: "Attack",
      amount_kobo: 1,
      series_id: randomUUID(),
      reason: "Attack",
      created_by: randomUUID(),
    }),
    { label: "Changed" },
  ),
  spec(
    "payroll_anomalies",
    (orgId) => ({
      organisation_id: orgId,
      run_id: randomUUID(),
      code: "first_pay",
      severity: "warning",
    }),
    { acknowledged_at: new Date().toISOString(), acknowledged_by: randomUUID() },
  ),
  spec(
    "payroll_run_decisions",
    (orgId) => ({
      organisation_id: orgId,
      run_id: randomUUID(),
      decision: "submitted",
      actor_id: randomUUID(),
      gross_kobo: 0,
      net_kobo: 0,
      worker_count: 0,
    }),
    { reason: "Changed" },
  ),
  spec(
    "payroll_approval_checks",
    (orgId) => ({
      organisation_id: orgId,
      run_id: randomUUID(),
      actor_id: randomUUID(),
      inputs_sha256: SHA,
      matches: true,
    }),
    { matches: false },
    async ({ admin, side }) => {
      const runId = await firstId(admin, "payroll_runs", side.orgId);
      const { error } = await admin.rpc("record_payroll_approval_check", {
        p_organisation_id: side.orgId,
        p_run_id: runId,
        p_actor: side.id,
        p_inputs_sha256: SHA,
      });
      if (error) throw new Error(`payroll_approval_checks: ${error.message}`);
    },
  ),
];
