/** Isolation registry for the business module (Phase 2). `clients` and `sites` stay in people.ts. */
import { randomUUID } from "node:crypto";

import type { TableSpec } from "../helpers/registry";
import type { Client } from "../helpers/supabase";

type BusinessTable =
  | "client_contacts"
  | "contracts"
  | "contract_sites"
  | "rate_cards"
  | "rate_card_lines"
  | "site_checkpoints";

async function firstId(admin: Client, table: BusinessTable, orgId: string) {
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
  // Slice 2.4: one draft contract per organisation with a site and a rate card of one line.
  // Seeded with the secret key (the rate tables have no write grants).
  {
    table: "contracts",
    ...byOrg,
    seed: async ({ admin, side }) => {
      const client = await admin
        .from("clients")
        .select("id")
        .eq("organisation_id", side.orgId)
        .order("created_at")
        .limit(1)
        .single();
      if (client.error) throw new Error(client.error.message);
      const clientId = client.data.id;
      const site = await admin
        .from("sites")
        .insert({ organisation_id: side.orgId, client_id: clientId, name: "Contract Gate" })
        .select("id")
        .single();
      if (site.error) throw new Error(site.error.message);
      const contract = await admin
        .from("contracts")
        .insert({
          organisation_id: side.orgId,
          client_id: clientId,
          reference: "",
          name: "Guarding",
          type: "manned_post",
          start_date: "2026-11-01",
        } as never)
        .select("id")
        .single();
      if (contract.error) throw new Error(contract.error.message);
      const contractId = contract.data.id;
      const link = await admin
        .from("contract_sites")
        .insert({ organisation_id: side.orgId, contract_id: contractId, site_id: site.data.id });
      if (link.error) throw new Error(link.error.message);
      const card = await admin
        .from("rate_cards")
        .insert({
          organisation_id: side.orgId,
          contract_id: contractId,
          effective_from: "2026-11-01",
        })
        .select("id")
        .single();
      if (card.error) throw new Error(card.error.message);
      const line = await admin.from("rate_card_lines").insert({
        organisation_id: side.orgId,
        rate_card_id: card.data.id,
        role: "Guard",
        band: "Day",
        unit: "shift",
        rate_kobo: 1_250_000,
        wht_rate_bps: 200,
      });
      if (line.error) throw new Error(line.error.message);
    },
    rowOf: ({ admin, side }) => firstId(admin, "contracts", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      client_id: randomUUID(),
      reference: "HIJACK-1",
      name: "Hijack",
      type: "manned_post",
      start_date: "2026-11-01",
    }),
    patch: { name: "Hijacked" },
  },
  {
    table: "contract_sites",
    ...byOrg,
    rowOf: ({ admin, side }) => firstId(admin, "contract_sites", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      contract_id: randomUUID(),
      site_id: randomUUID(),
    }),
    patch: { site_id: randomUUID() },
  },
  {
    table: "rate_cards",
    ...byOrg,
    rowOf: ({ admin, side }) => firstId(admin, "rate_cards", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      contract_id: randomUUID(),
      effective_from: "2027-01-01",
    }),
    patch: { note: "Hijacked" },
  },
  {
    table: "rate_card_lines",
    ...byOrg,
    rowOf: ({ admin, side }) => firstId(admin, "rate_card_lines", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      rate_card_id: randomUUID(),
      role: "Guard",
      unit: "shift",
      rate_kobo: 1,
    }),
    patch: { rate_kobo: 1 },
  },
];
