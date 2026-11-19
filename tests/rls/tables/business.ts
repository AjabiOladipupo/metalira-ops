/** Isolation registry for the business module (Phase 2). `clients` and `sites` stay in people.ts. */
import { randomUUID } from "node:crypto";

import type { TableSpec } from "../helpers/registry";
import type { Client } from "../helpers/supabase";

async function firstId(admin: Client, table: "client_contacts", orgId: string) {
  const { data, error } = await admin
    .from(table)
    .select("id")
    .eq("organisation_id", orgId)
    .order("created_at")
    .limit(1);
  if (error) throw new Error(error.message);
  const id = data?.[0]?.id;
  if (!id) throw new Error(`fixture row not found in ${table}`);
  return id;
}

const byOrg = {
  key: "id",
  tenantColumn: "organisation_id",
  tenantValue: (side: { orgId: string }) => side.orgId,
} as const;

export const tables: TableSpec[] = [
  {
    table: "client_contacts",
    ...byOrg,
    // Registry files load alphabetically, so this runs before people.ts seeds `clients`: it
    // brings its own client.
    seed: async ({ admin, side }) => {
      const client = await admin
        .from("clients")
        .insert({ organisation_id: side.orgId, name: "Greenfield Estates" })
        .select("id")
        .single();
      if (client.error) throw new Error(client.error.message);
      const clientId = client.data.id;
      const { error } = await admin.from("client_contacts").insert({
        organisation_id: side.orgId,
        client_id: clientId,
        name: "Ngozi Eze",
        email: `accounts-${side.orgId.slice(0, 8)}@coastline.example`,
        role: "billing",
      });
      if (error) throw new Error(error.message);
    },
    rowOf: ({ admin, side }) => firstId(admin, "client_contacts", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      client_id: randomUUID(),
      name: "Hijack",
      email: "hijack@example.test",
      role: "billing",
    }),
    patch: { name: "Hijacked" },
  },
];
