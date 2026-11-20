/**
 * Isolation registry for account name lookups (slice 2.3b). Rows are written only with the
 * secret key (the server's lookup); signed-in users read their own.
 */
import type { TableSpec } from "../helpers/registry";
import { makeLookup, randomDigest } from "../helpers/bank-lookup";

export const tables: TableSpec[] = [
  {
    table: "bank_account_lookups",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ admin, side }) => {
      await makeLookup(admin, {
        orgId: side.orgId,
        userId: side.id,
        purpose: "company_bank",
        last4: "4410",
      });
    },
    rowOf: async ({ admin, side }) => {
      const { data, error } = await admin
        .from("bank_account_lookups")
        .select("id")
        .eq("organisation_id", side.orgId)
        .order("created_at")
        .limit(1)
        .single();
      if (error) throw new Error(error.message);
      return data.id;
    },
    attackInsert: ({ victim, attacker }) => ({
      organisation_id: victim.orgId,
      requested_by: attacker.id,
      purpose: "company_bank",
      bank_code: "058",
      bank_account_digest: randomDigest(),
      bank_account_last4: "0000",
      status: "resolved",
      account_name: "VICTIM LIMITED",
      source: "bank",
      finished_at: new Date().toISOString(),
    }),
    patch: { account_name: "HIJACKED" },
  },
];
