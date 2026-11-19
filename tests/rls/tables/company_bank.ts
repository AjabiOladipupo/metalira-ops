/**
 * Isolation registry for the company bank account (slice 2.3). Its own file, so it doesn't
 * collide with slice 2.1's business.ts.
 */
import { randomBytes, randomUUID } from "node:crypto";

import type { TableSpec } from "../helpers/registry";

export const tables: TableSpec[] = [
  {
    table: "organisation_bank_accounts",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ admin, side }) => {
      // The secret key has no signed-in user, so the requester is named explicitly; the row is
      // a pending request (the trigger allows nothing else without a signed-in owner).
      const { error } = await admin.from("organisation_bank_accounts").insert({
        organisation_id: side.orgId,
        requested_by: side.id,
        bank_name: "GTBank",
        account_name: "Isolation Ltd",
        bank_account_enc: `\\x${randomBytes(40).toString("hex")}`,
        bank_account_last4: "4410",
      });
      if (error) throw new Error(error.message);
    },
    rowOf: async ({ admin, side }) => {
      const { data, error } = await admin
        .from("organisation_bank_accounts")
        .select("id")
        .eq("organisation_id", side.orgId)
        .order("created_at")
        .limit(1)
        .single();
      if (error) throw new Error(error.message);
      return data.id;
    },
    attackInsert: ({ victim }) => ({
      id: randomUUID(),
      organisation_id: victim.orgId,
      bank_name: "Hijack Bank",
      account_name: "Hijack",
      bank_account_enc: `\\x${randomBytes(40).toString("hex")}`,
      bank_account_last4: "0000",
    }),
    patch: { status: "approved" },
  },
];
