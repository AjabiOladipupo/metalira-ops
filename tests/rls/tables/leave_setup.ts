/**
 * Isolation registry for slice 4.1 (company calendar and leave setup). Rows are seeded with the
 * secret key, which may insert but never delete; signed-in roles have no write grants (the SQL
 * functions write), and the guards refuse deletes and changes.
 */
import { randomUUID } from "node:crypto";

import type { TableSpec } from "../helpers/registry";
import type { Client } from "../helpers/supabase";

async function firstId(
  admin: Client,
  table: "public_holidays" | "leave_types" | "leave_entitlements",
  orgId: string,
): Promise<string> {
  const { data, error } = await admin
    .from(table)
    .select("id")
    .eq("organisation_id", orgId)
    .order("created_at")
    .limit(1)
    .single();
  if (error) throw new Error(error.message);
  return data.id;
}

export const tables: TableSpec[] = [
  {
    table: "public_holidays",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ admin, side }) => {
      const { error } = await admin
        .from("public_holidays")
        .insert({ organisation_id: side.orgId, holiday_date: "2026-10-01", name: "Independence Day" });
      if (error) throw new Error(error.message);
    },
    rowOf: async ({ admin, side }) => firstId(admin, "public_holidays", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      holiday_date: "2026-12-25",
      name: "Christmas Day",
    }),
    patch: { name: "Changed" },
  },
  {
    table: "leave_types",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ admin, side }) => {
      const { data, error } = await admin
        .from("leave_types")
        .insert({ organisation_id: side.orgId, code: "annual", name: "Annual" })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      const version = await admin.from("leave_entitlements").insert({
        organisation_id: side.orgId,
        leave_type_id: data.id,
        effective_from: "2026-01-01",
        days_per_year: 15,
      });
      if (version.error) throw new Error(version.error.message);
    },
    rowOf: async ({ admin, side }) => firstId(admin, "leave_types", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      code: `attack_${randomUUID().slice(0, 6)}`,
      name: "Attack",
    }),
    patch: { name: "Changed" },
  },
  {
    // Seeded with its type above (leave_types loads first in this file).
    table: "leave_entitlements",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    rowOf: async ({ admin, side }) => firstId(admin, "leave_entitlements", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      leave_type_id: randomUUID(),
      effective_from: "2030-01-01",
      days_per_year: 99,
    }),
    patch: { effective_to: "2030-12-31" },
  },
];
