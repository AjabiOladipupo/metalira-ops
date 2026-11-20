/**
 * Isolation registry for slice 3.5 (punches). Loads after people.ts (a worker per organisation).
 * Nobody, the secret key included, has write grants on punches (record_punch is the only
 * writer), so the seed inserts as the database owner. `location` is not granted to signed-in
 * users, so it is left out of the select.
 */
import { randomUUID } from "node:crypto";

import type { TableSpec } from "../helpers/registry";
import { pgClient, type Client } from "../helpers/supabase";

async function firstWorker(admin: Client, orgId: string): Promise<string> {
  const { data, error } = await admin
    .from("workers")
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
    table: "punches",
    key: "id",
    selectColumns:
      "id, organisation_id, worker_id, kind, recorded_at, geofence_result, distance_m, flags, selfie_path",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ admin, side }) => {
      const worker = await firstWorker(admin, side.orgId);
      const db = await pgClient();
      try {
        await db.query(
          `insert into public.punches (
             organisation_id, worker_id, kind, recorded_by_user, client_event_id, device_time,
             recorded_at, time_source, clock_drift_seconds, geofence_result, flags, payload_hash
           ) values ($1, $2, 'in', $3, $4, now(), now(), 'elapsed', 0, 'unknown',
             array['no_shift', 'no_location', 'no_selfie'], md5('seed'))`,
          [side.orgId, worker, side.id, randomUUID()],
        );
      } finally {
        await db.end();
      }
    },
    rowOf: async ({ admin, side }) => {
      const { data, error } = await admin
        .from("punches")
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
      kind: "in",
      recorded_by_user: randomUUID(),
      client_event_id: randomUUID(),
      device_time: "2026-12-01T05:00:00Z",
      recorded_at: "2026-12-01T05:00:00Z",
      time_source: "device",
      clock_drift_seconds: 0,
      geofence_result: "inside",
      payload_hash: "0".repeat(32),
    }),
    patch: { geofence_result: "inside" },
  },
];
