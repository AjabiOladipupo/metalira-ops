/** Isolation registry for owner changes (slice 1.13). */
import { randomUUID } from "node:crypto";

import type { TableSpec } from "../helpers/registry";

export const tables: TableSpec[] = [
  {
    table: "owner_changes",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ side }) => {
      // The secret key can't write owner_changes, so the company's only owner asks (one owner
      // inviting an owner happens at once).
      const { error } = await side.client.rpc("request_owner_change", {
        p_organisation_id: side.orgId,
        p_kind: "invite",
        p_email: `owner-${randomUUID()}@example.test`,
      });
      if (error) throw new Error(error.message);
    },
    rowOf: async ({ admin, side }) => {
      const { data, error } = await admin
        .from("owner_changes")
        .select("id")
        .eq("organisation_id", side.orgId)
        .order("created_at")
        .limit(1)
        .single();
      if (error) throw new Error(error.message);
      return data.id;
    },
    attackInsert: ({ attacker, victim }) => ({
      organisation_id: victim.orgId,
      kind: "invite",
      invite_email: attacker.email.toLowerCase(),
      requested_by: attacker.id,
      owners_at_request: 1,
      single_owner: true,
    }),
    patch: { status: "rejected" },
  },
];
