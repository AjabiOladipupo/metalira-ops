/**
 * Isolation registry for slice 5.9a (the tax adviser's engine records): opening balances, relief
 * declarations, their proofs and verifications, and NHF numbers. Each side's owner writes through
 * the SQL functions (the proof with the secret key, as the server does); signed-in roles have no
 * write grants and the rows are insert-only, so every attack is refused.
 */
import { randomBytes, randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { TableSpec } from "../helpers/registry";
import { addPayrollWorker } from "../helpers/payroll";
import { reliefChecker, verifyRelief } from "../helpers/reliefs";
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

const base = (table: string) => ({
  table,
  key: "id",
  tenantColumn: "organisation_id",
  tenantValue: (side: { orgId: string }) => side.orgId,
  rowOf: ({ admin, side }: { admin: Client; side: { orgId: string } }) =>
    firstId(admin, table, side.orgId),
});

export const tables: TableSpec[] = [
  {
    ...base("payroll_opening_balances"),
    seed: async ({ admin, side }) => {
      const { workerId } = await addPayrollWorker(admin, side.orgId);
      const { error } = await side.client.rpc("record_payroll_opening_balance", {
        p_organisation_id: side.orgId,
        p_worker_id: workerId,
        p_tax_year: 2026,
        p_as_of_month: "2026-08-01",
        p_gross_kobo: "96000000",
        p_chargeable_kobo: "88320000",
        p_paye_kobo: "5248000",
        p_pension_kobo: "7680000",
        p_reason: "Isolation seed",
      });
      if (error) throw new Error(`payroll_opening_balances: ${error.message}`);
    },
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      worker_id: randomUUID(),
      tax_year: 2026,
      as_of_month: "2026-08-01",
      ytd_gross_kobo: 1,
      ytd_chargeable_kobo: 1,
      ytd_paye_kobo: 0,
      ytd_pension_kobo: 0,
      reason: "Attack",
      created_by: randomUUID(),
    }),
    patch: { ytd_paye_kobo: 0 },
  },
  {
    ...base("payroll_relief_declarations"),
    seed: async ({ admin, side }) => {
      const { workerId } = await addPayrollWorker(admin, side.orgId);
      await verifyRelief(
        admin,
        { client: side.client, userId: side.id },
        await reliefChecker(admin, side.orgId),
        side.orgId,
        workerId,
        "rent",
        36_000_000n,
      );
    },
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      worker_id: randomUUID(),
      tax_year: 2026,
      kind: "rent",
      annual_amount_kobo: 1,
      reason: "Attack",
      created_by: randomUUID(),
    }),
    patch: { annual_amount_kobo: 0 },
  },
  {
    ...base("payroll_relief_proofs"),
    attackInsert: ({ victim }) => ({
      id: randomUUID(),
      organisation_id: victim.orgId,
      declaration_id: randomUUID(),
      worker_id: randomUUID(),
      document_kind: "other",
      file_ext: "pdf",
      mime_type: "application/pdf",
      size_bytes: 10,
      sha256: "0".repeat(64),
      storage_path: "x",
      checked_by: randomUUID(),
    }),
    patch: { document_kind: "other" },
  },
  {
    ...base("payroll_relief_verifications"),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      declaration_id: randomUUID(),
      worker_id: randomUUID(),
      decision: "verified",
      created_by: randomUUID(),
    }),
    patch: { note: "Changed" },
  },
  {
    ...base("payroll_nhf_numbers"),
    seed: async ({ admin, side }) => {
      const { workerId } = await addPayrollWorker(admin, side.orgId);
      const { error } = await side.client.rpc("set_payroll_nhf_number", {
        p_organisation_id: side.orgId,
        p_worker_id: workerId,
        p_id: randomUUID(),
        // Stands in for the server's ciphertext (the database never sees the number).
        p_nhf_number_enc: `\\x${randomBytes(48).toString("hex")}`,
        p_last4: "0042",
        p_reason: "Isolation seed",
      });
      if (error) throw new Error(`payroll_nhf_numbers: ${error.message}`);
    },
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      worker_id: randomUUID(),
      nhf_number_last4: "9999",
      reason: "Attack",
      created_by: randomUUID(),
    }),
    patch: { reason: "Changed" },
  },
  {
    ...base("payroll_itf_turnover"),
    seed: async ({ side }) => {
      const { error } = await side.client.rpc("set_itf_turnover_flag", {
        p_organisation_id: side.orgId,
        p_value: true,
        p_effective_from: "2026-01-01",
        p_reason: "Isolation seed",
      });
      if (error) throw new Error(`payroll_itf_turnover: ${error.message}`);
    },
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      over_50m: true,
      effective_from: "2026-01-01",
      reason: "Attack",
      created_by: randomUUID(),
    }),
    patch: { over_50m: false },
  },
];
