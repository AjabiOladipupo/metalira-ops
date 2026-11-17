/**
 * Isolation registry for staff ID corrections (slice 1.11). Named so it loads after people.ts,
 * whose workers the seed points at.
 */
import { randomUUID } from "node:crypto";

import type { TableSpec } from "../helpers/registry";

export const tables: TableSpec[] = [
  {
    table: "staff_id_corrections",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ admin, side }) => {
      const worker = await admin
        .from("workers")
        .select("id")
        .eq("organisation_id", side.orgId)
        .eq("status", "active")
        .order("created_at")
        .limit(1)
        .single();
      if (worker.error) throw new Error(worker.error.message);
      // The secret key has no signed-in user, so the requester is named explicitly; the trigger
      // fills old_staff_id from the worker.
      const { error } = await admin.from("staff_id_corrections").insert({
        organisation_id: side.orgId,
        worker_id: worker.data.id,
        old_staff_id: "ignored",
        new_staff_id: `ISO-${randomUUID().slice(0, 8)}`,
        reason: "Typo at import",
        requested_by: side.id,
      });
      if (error) throw new Error(error.message);
    },
    rowOf: async ({ admin, side }) => {
      const { data, error } = await admin
        .from("staff_id_corrections")
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
      new_staff_id: "HIJACK-1",
      reason: "Hijack attempt",
    }),
    patch: { status: "approved" },
  },
];
