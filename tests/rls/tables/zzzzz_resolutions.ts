/**
 * Isolation registry for slice 5.7c's remittance refunds and offsets. Each side gets a January
 * 2026 run for a new worker, approved by a Finance member made for the seed; its PAYE is paid with
 * a receipt; the run is reversed by two people (5.7a), voiding the remittance; the payment is then
 * offset against the side's February PAYE (zzzz_supplements.ts's released run). Signed-in roles
 * have no write grant on the table, so every attack is 42501.
 *
 * Named to sort after zzzz_supplements.ts, whose February run is the offset's target.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { TableSpec } from "../helpers/registry";
import { addPayrollWorker } from "../helpers/payroll";
import { approveRun, submitRunFor } from "../helpers/payslips";
import { seedReceipt } from "../helpers/statutory";
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

async function paye(admin: Client, runId: string): Promise<string> {
  const { data, error } = await admin
    .from("statutory_remittances")
    .select("id")
    .eq("run_id", runId)
    .eq("kind", "paye")
    .single();
  if (error) throw new Error(`statutory_payment_resolutions: ${error.message}`);
  return data.id;
}

export const tables: TableSpec[] = [
  {
    table: "statutory_payment_resolutions",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ admin, side }) => {
      const fail = (what: string, e: { message: string } | null) => {
        if (e) throw new Error(`statutory_payment_resolutions: ${what}: ${e.message}`);
      };
      const finance = await createTestUser("iso-res-fin");
      const finance2 = await createTestUser("iso-res-fin2");
      for (const u of [finance, finance2]) {
        fail(
          "member",
          (
            await admin
              .from("memberships")
              .insert({ organisation_id: side.orgId, user_id: u.id, role: "finance" })
          ).error,
        );
      }
      const worker = await addPayrollWorker(admin, side.orgId);
      const jan = await submitRunFor(admin, side, worker, "2025-12-20");
      await approveRun(admin, side.orgId, jan, finance);
      const janPaye = await paye(admin, jan);
      const receipt = await seedReceipt(admin, side.orgId, janPaye, finance.id);
      fail("receipt", receipt.error as { message: string } | null);
      const paid = await finance.client.rpc("record_statutory_payment", {
        p_organisation_id: side.orgId,
        p_remittance_id: janPaye,
        p_receipt_id: receipt.receiptId,
        p_paid_on: "2026-01-20",
        p_paid_amount_kobo: "100000",
        p_reference: "LIRS-JAN",
      });
      fail("payment", paid.error);
      const reversal = await finance.client.rpc("reverse_payroll_run", {
        p_organisation_id: side.orgId,
        p_run_id: jan,
        p_reason: "Wrong rate in January",
      });
      fail("reverse", reversal.error);
      fail(
        "approve reversal",
        (
          await finance2.client.rpc("approve_payroll_reversal", {
            p_organisation_id: side.orgId,
            p_run_id: reversal.data!,
          })
        ).error,
      );
      const { data: feb, error: febError } = await admin
        .from("payroll_runs")
        .select("id")
        .eq("organisation_id", side.orgId)
        .eq("period_start", "2026-02-20")
        .single();
      fail("february", febError);
      fail(
        "offset",
        (
          await finance.client.rpc("record_remittance_offset", {
            p_organisation_id: side.orgId,
            p_payment_id: paid.data!,
            p_target_remittance_id: await paye(admin, feb!.id),
            p_amount_kobo: "50000",
            p_note: "Agreed with the state IRS",
          })
        ).error,
      );
      const db = await pgClient();
      try {
        await db.query(
          "delete from public.memberships where organisation_id = $1 and user_id = any($2::uuid[])",
          [side.orgId, [finance.id, finance2.id]],
        );
      } finally {
        await db.end();
      }
    },
    rowOf: ({ admin, side }) => firstId(admin, "statutory_payment_resolutions", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      payment_id: randomUUID(),
      remittance_id: randomUUID(),
      kind: "offset",
      amount_kobo: 1,
      target_remittance_id: randomUUID(),
      note: "x",
      recorded_by: randomUUID(),
    }),
    patch: { amount_kobo: 2 },
  },
];
