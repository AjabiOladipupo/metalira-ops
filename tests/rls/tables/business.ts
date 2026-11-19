/** Isolation registry for the business module (Phase 2). `clients` and `sites` stay in people.ts. */
import { randomUUID } from "node:crypto";

import type { TableSpec } from "../helpers/registry";
import type { Client } from "../helpers/supabase";

async function firstId(
  admin: Client,
  table: "client_contacts" | "site_checkpoints",
  orgId: string,
) {
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
  {
    table: "site_checkpoints",
    ...byOrg,
    // Slice 2.2. Seeds its own client and site (this file loads before people.ts). qr_token is
    // not granted to signed-in users; it is read through site_checkpoint_tokens.
    seed: async ({ admin, side }) => {
      const client = await admin
        .from("clients")
        .insert({ organisation_id: side.orgId, name: "Marina VI Tower" })
        .select("id")
        .single();
      if (client.error) throw new Error(client.error.message);
      const site = await admin
        .from("sites")
        .insert({ organisation_id: side.orgId, client_id: client.data.id, name: "Tower lobby" })
        .select("id")
        .single();
      if (site.error) throw new Error(site.error.message);
      const { error } = await admin
        .from("site_checkpoints")
        .insert({ organisation_id: side.orgId, site_id: site.data.id, name: "Gate A" });
      if (error) throw new Error(error.message);
    },
    rowOf: ({ admin, side }) => firstId(admin, "site_checkpoints", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      site_id: randomUUID(),
      name: "Hijack",
    }),
    selectColumns: "id, organisation_id, site_id, name, sort_order, status",
    patch: { name: "Hijacked" },
  },
];
