/** Isolation registry for self-onboarding invites (slice U.4). */
import { randomUUID } from "node:crypto";

import type { TableSpec } from "../helpers/registry";

export const tables: TableSpec[] = [
  {
    table: "onboarding_invites",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ side }) => {
      // Only the functions write invites: the company's owner sends one.
      const { error } = await side.client.rpc("create_self_onboarding_invite", {
        p_organisation_id: side.orgId,
        p_email: `onboard-${randomUUID()}@example.test`,
        p_role: "guard",
      });
      if (error) throw new Error(error.message);
    },
    rowOf: async ({ admin, side }) => {
      const { data, error } = await admin
        .from("onboarding_invites")
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
      email: `attack-${randomUUID()}@example.test`,
      role: "hr",
      token_hash: "a".repeat(64),
      created_by: attacker.id,
    }),
    patch: { status: "cancelled" },
  },
];
