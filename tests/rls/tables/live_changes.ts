/**
 * Isolation registry for slice 2.8 (changes to a live contract). Loads after business.ts, whose
 * `posts` seed gives each organisation a live contract with one post. Rows are written with the
 * secret key here; no signed-in role has write grants (the 2.8 SQL functions write them).
 */
import { randomUUID } from "node:crypto";

import type { TableSpec } from "../helpers/registry";

export const tables: TableSpec[] = [
  {
    table: "contract_changes",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ admin, side }) => {
      const post = await admin
        .from("posts")
        .select("id, contract_id, site_id")
        .eq("organisation_id", side.orgId)
        .order("created_at")
        .limit(1)
        .single();
      if (post.error) throw new Error(post.error.message);
      const { error } = await admin.from("contract_changes").insert({
        organisation_id: side.orgId,
        contract_id: post.data.contract_id,
        post_id: post.data.id,
        site_id: post.data.site_id,
        kind: "requirement_changed",
        effective_on: "2026-12-07",
        reason: "Client asked for a second guard.",
      });
      if (error) throw new Error(error.message);
    },
    rowOf: async ({ admin, side }) => {
      const { data, error } = await admin
        .from("contract_changes")
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
      contract_id: randomUUID(),
      site_id: randomUUID(),
      kind: "site_added",
      effective_on: "2026-12-07",
    }),
    patch: { reason: "Hijacked" },
  },
];
