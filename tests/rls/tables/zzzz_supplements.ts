/**
 * Isolation registry for slice 5.7c (supplementary payout files). Each side gets a March 2026 run
 * for a new worker without bank details (HR acknowledges it), posted and released through the
 * functions (the owner prepares and makes the bank file, which leaves the worker out; a Finance
 * member made for the seed approves and releases). The worker then gets bank details and the
 * owner makes the supplementary file through the server's two steps. Signed-in roles have no
 * write grants on either table, so every attack is 42501.
 *
 * Named to sort after zzz_payouts.ts.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Json } from "@/types/db";

import type { TableSpec } from "../helpers/registry";
import {
  BUCKET,
  download,
  giveBankDetails,
  makeBatch,
  payAll,
  release,
} from "../helpers/payout";
import { addPayrollWorker, resultsFor, saveResults } from "../helpers/payroll";
import { approveRun, periodEnd } from "../helpers/payslips";
import { createTestUser, pgClient, type Client } from "../helpers/supabase";

const PERIOD = "2026-02-20";

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
    table: "payout_supplements",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ admin, side }) => {
      const fail = (what: string, e: { message: string } | null) => {
        if (e) throw new Error(`payout_supplements: ${what}: ${e.message}`);
      };
      // Two workers: the bank file pays one (5.4 refuses a file that pays nobody) and leaves the
      // other out.
      const paid = await addPayrollWorker(admin, side.orgId);
      await giveBankDetails(admin, side.orgId, paid.workerId);
      const worker = await addPayrollWorker(admin, side.orgId);
      const finance = await createTestUser("iso-supp-fin");
      fail(
        "member",
        (
          await admin
            .from("memberships")
            .insert({ organisation_id: side.orgId, user_id: finance.id, role: "finance" })
        ).error,
      );
      const created = await side.client.rpc("create_payroll_run", {
        p_organisation_id: side.orgId,
        p_period_start: PERIOD,
      });
      fail("create", created.error);
      const runId = created.data!;
      const period = { start: PERIOD, end: periodEnd(PERIOD) };
      const doc = resultsFor({ ...paid, adjustmentId: null }, { period, anomalies: [] }) as {
        payslips: unknown[];
        totals: Record<string, string | number>;
        anomalies: unknown[];
      };
      const other = resultsFor({ ...worker, adjustmentId: null }, { period }) as typeof doc;
      doc.payslips.push(...other.payslips);
      for (const [k, v] of Object.entries(other.totals)) {
        const mine = doc.totals[k]!;
        doc.totals[k] = typeof v === "number" ? Number(mine) + v : String(BigInt(mine) + BigInt(v));
      }
      doc.anomalies = [
        { worker_id: worker.workerId, code: "bank_missing", severity: "warning", detail: {} },
      ];
      fail("save", (await saveResults(admin, side, runId, doc)).error);
      const { data: anomalies } = await admin
        .from("payroll_anomalies")
        .select("id")
        .eq("run_id", runId);
      fail(
        "acknowledge",
        (
          await side.client.rpc("acknowledge_payroll_anomalies", {
            p_organisation_id: side.orgId,
            p_run_id: runId,
            p_anomaly_ids: (anomalies ?? []).map((a) => a.id),
          })
        ).error,
      );
      fail(
        "submit",
        (
          await side.client.rpc("submit_payroll_run", {
            p_organisation_id: side.orgId,
            p_run_id: runId,
          })
        ).error,
      );
      await approveRun(admin, side.orgId, runId, finance);
      const { data: slip } = await admin
        .from("payslips")
        .select("id")
        .eq("run_id", runId)
        .eq("worker_id", worker.workerId)
        .single();
      const made = await makeBatch(admin, side.client, side.orgId, runId, {
        items: (plan) => {
          const pay = plan.filter((r) => r.payslip_id !== slip!.id);
          return [
            ...payAll(pay),
            {
              payslip_id: slip!.id,
              position: pay.length + 1,
              status: "left_out",
              left_out_reason: "no_bank_details",
              amount_kobo: "0",
            },
          ];
        },
      });
      if (made.error) throw new Error(`payout_supplements: bank file: ${made.error.message}`);
      fail("download", (await download(side.client, side.orgId, made.batchId)).error);
      fail("release", (await release(finance.client, side.orgId, runId, made.batchId)).error);

      await giveBankDetails(admin, side.orgId, worker.workerId);
      const plan = await side.client.rpc("payout_supplement_plan", {
        p_organisation_id: side.orgId,
        p_run_id: runId,
        p_with_ciphertext: false,
      });
      fail("plan", plan.error);
      const id = randomUUID();
      const body = Buffer.from("Beneficiary name\r\nMUSA IBRAHIM\r\n", "utf8");
      fail(
        "store",
        (
          await admin.storage
            .from(BUCKET)
            .upload(`${side.orgId}/${runId}/supplementary/${id}.csv`, body, {
              contentType: "text/csv",
            })
        ).error,
      );
      const rows = (plan.data ?? []) as unknown as Record<string, string | null>[];
      fail(
        "make",
        (
          await side.client.rpc("make_payout_supplement", {
            p_organisation_id: side.orgId,
            p_run_id: runId,
            p_supplement_id: id,
            p_bank_format: "generic-csv",
            p_file_sha256: "c".repeat(64),
            p_file_bytes: body.byteLength,
            p_items: rows.map((r, i) => ({
              payslip_id: r.payslip_id,
              position: i + 1,
              bank_name: r.bank_name,
              bank_code: r.bank_code,
              account_name: r.account_name,
              bank_account_last4: r.bank_account_last4,
              bank_detail_change_id: r.bank_detail_change_id,
              amount_kobo: r.net_kobo,
            })) as Json,
          })
        ).error,
      );
      const db = await pgClient();
      try {
        // The side keeps only its owner as a member (isolation.test.ts checks the memberships).
        await db.query(
          "delete from public.memberships where organisation_id = $1 and user_id = $2",
          [side.orgId, finance.id],
        );
      } finally {
        await db.end();
      }
    },
    rowOf: ({ admin, side }) => firstId(admin, "payout_supplements", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      run_id: randomUUID(),
      bank_format: "generic-csv",
      file_path: `${victim.orgId}/x/supplementary/y.csv`,
      file_sha256: "c".repeat(64),
      file_bytes: 1,
      item_count: 1,
      total_kobo: 1,
      made_by: randomUUID(),
    }),
    patch: { void_reason: "Changed" },
  },
  {
    // Seeded above.
    table: "payout_supplement_items",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    rowOf: ({ admin, side }) => firstId(admin, "payout_supplement_items", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      supplement_id: randomUUID(),
      run_id: randomUUID(),
      payslip_id: randomUUID(),
      worker_id: randomUUID(),
      original_item_id: randomUUID(),
      position: 1,
      bank_name: "GTBank",
      bank_code: "058",
      account_name: "MUSA IBRAHIM",
      bank_account_last4: "6789",
      amount_kobo: 1,
    }),
    patch: { amount_kobo: 2 },
  },
];
