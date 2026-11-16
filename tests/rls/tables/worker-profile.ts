/**
 * Isolation registry for worker change requests (slice 1.10). Named so it loads after people.ts,
 * whose workers the seed points at.
 */
import { randomUUID } from "node:crypto";

import type { TableSpec } from "../helpers/registry";

export const tables: TableSpec[] = [
  {
    table: "worker_change_requests",
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
      const { error } = await admin.from("worker_change_requests").insert({
        organisation_id: side.orgId,
        worker_id: worker.data.id,
        requested_by: side.id,
        topic: "name",
        details: "My surname is spelt Adebayo",
      });
      if (error) throw new Error(error.message);
    },
    rowOf: async ({ admin, side }) => {
      const { data, error } = await admin
        .from("worker_change_requests")
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
      topic: "other",
      details: "Pay me instead",
    }),
    patch: { status: "done" },
  },
];
