/**
 * Isolation registry for bank-detail changes (slice 1.7). Named so it loads after people.ts,
 * whose workers the seed points at.
 */
import { randomBytes, randomUUID } from "node:crypto";

import type { TableSpec } from "../helpers/registry";

export const tables: TableSpec[] = [
  {
    table: "bank_detail_changes",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ admin, side }) => {
      const worker = await admin
        .from("workers")
        .select("id")
        .eq("organisation_id", side.orgId)
        .order("created_at")
        .limit(1)
        .single();
      if (worker.error) throw new Error(worker.error.message);
      // The secret key has no signed-in user, so the requester is named explicitly.
      const { error } = await admin.from("bank_detail_changes").insert({
        organisation_id: side.orgId,
        worker_id: worker.data.id,
        requested_by: side.id,
        bank_name: "GTBank",
        account_name: "Ada Worker",
        bank_account_enc: `\\x${randomBytes(40).toString("hex")}`,
        bank_account_last4: "7712",
      });
      if (error) throw new Error(error.message);
    },
    rowOf: async ({ admin, side }) => {
      const { data, error } = await admin
        .from("bank_detail_changes")
        .select("id")
        .eq("organisation_id", side.orgId)
        .order("created_at")
        .limit(1)
        .single();
      if (error) throw new Error(error.message);
      return data.id;
    },
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      worker_id: randomUUID(),
      bank_name: "Hijack Bank",
      account_name: "Hijack",
      bank_account_enc: `\\x${randomBytes(40).toString("hex")}`,
      bank_account_last4: "0000",
    }),
    patch: { status: "approved" },
  },
];
