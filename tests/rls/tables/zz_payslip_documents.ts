/**
 * Isolation registry for slice 5.5: payslip_documents and payslip_snapshots. Each side gets a June 2026 run for a new
 * worker, posted through the functions and approved by a Finance member made for the seed, marked
 * released (TODO(5.4): release_payroll_run), with one PDF uploaded and recorded with the secret
 * key. Signed-in roles have no write grant on the table, so every attack is refused.
 *
 * Named to sort after zz_payroll_runs.ts, whose seeds pick a company's first run in review.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { TableSpec } from "../helpers/registry";
import { addPayrollWorker } from "../helpers/payroll";
import { approveRun, markReleased, recordDocument, submitRunFor } from "../helpers/payslips";
import { createTestUser, pgClient, type Client } from "../helpers/supabase";

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
    table: "payslip_documents",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ admin, side }) => {
      const worker = await addPayrollWorker(admin, side.orgId);
      const finance = await createTestUser("iso-payslip-fin");
      const member = await admin
        .from("memberships")
        .insert({ organisation_id: side.orgId, user_id: finance.id, role: "finance" });
      if (member.error) throw new Error(`payslip_documents: ${member.error.message}`);
      const runId = await submitRunFor(admin, side, worker, "2026-05-20");
      await approveRun(admin, side.orgId, runId, finance);
      const db = await pgClient();
      try {
        await markReleased(db, runId, finance.id);
        // The side keeps only its owner as a member (isolation.test.ts checks the memberships).
        await db.query(
          "delete from public.memberships where organisation_id = $1 and user_id = $2",
          [side.orgId, finance.id],
        );
      } finally {
        await db.end();
      }
      const { data: slip, error } = await admin
        .from("payslips")
        .select("id")
        .eq("run_id", runId)
        .single();
      if (error) throw new Error(`payslip_documents: ${error.message}`);
      // Freezes the payslip (payslip_snapshots), as the server does before making the PDF.
      const views = await admin.rpc("payslip_pdf_views", {
        p_organisation_id: side.orgId,
        p_run_id: runId,
      });
      if (views.error) throw new Error(`payslip_snapshots: ${views.error.message}`);
      await recordDocument(admin, side.orgId, runId, slip.id, finance.id);
    },
    rowOf: ({ admin, side }) => firstId(admin, "payslip_documents", side.orgId),
    attackInsert: ({ victim }) => {
      const runId = randomUUID();
      const payslipId = randomUUID();
      return {
        organisation_id: victim.orgId,
        payslip_id: payslipId,
        run_id: runId,
        storage_path: `${victim.orgId}/${runId}/${payslipId}.pdf`,
        sha256: "d".repeat(64),
        size_bytes: 10,
      };
    },
    patch: { size_bytes: 2 },
  },
  {
    // Seeded above (payslip_pdf_views freezes the side's released payslip).
    table: "payslip_snapshots",
    key: "payslip_id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    rowOf: async ({ admin, side }) => {
      const { data, error } = await (admin as unknown as SupabaseClient)
        .from("payslip_snapshots")
        .select("payslip_id")
        .eq("organisation_id", side.orgId)
        .limit(1)
        .single();
      if (error) throw new Error(`payslip_snapshots: ${error.message}`);
      return (data as { payslip_id: string }).payslip_id;
    },
    attackInsert: ({ victim }) => ({
      payslip_id: randomUUID(),
      organisation_id: victim.orgId,
      run_id: randomUUID(),
      ytd_year: 2026,
      ytd_payslips: 1,
      ytd_gross_kobo: 1,
      ytd_paye_kobo: 0,
      ytd_pension_employee_kobo: 0,
      ytd_nhf_kobo: 0,
      ytd_net_kobo: 1,
    }),
    patch: { ytd_net_kobo: 2 },
  },
];
