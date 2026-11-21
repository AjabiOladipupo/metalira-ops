/**
 * Isolation registry for slice 3.6 (crew_punch_batches), on a site made here for it. Nobody, the
 * secret key included, has write grants on the table (record_crew_punch is the only writer), so
 * the seed inserts as the database owner. The payload hash is not granted.
 */
import { randomUUID } from "node:crypto";

import type { TableSpec } from "../helpers/registry";
import { pgClient } from "../helpers/supabase";

export const tables: TableSpec[] = [
  {
    table: "crew_punch_batches",
    key: "id",
    selectColumns:
      "id, organisation_id, kind, site_id, recorded_by_user, worker_count, geofence_result, photo_path",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ admin, side }) => {
      const client = await side.client.rpc("create_client", {
        p_organisation_id: side.orgId,
        p_name: `Crew Isolation ${randomUUID().slice(0, 8)}`,
        p_contact_name: "Ada Obi",
        p_contact_email: `crew-${randomUUID().slice(0, 8)}@isolation.example`,
      });
      if (client.error) throw new Error(client.error.message);
      const site = await admin
        .from("sites")
        .insert({ organisation_id: side.orgId, client_id: client.data, name: "Crew Gate" } as never)
        .select("id")
        .single();
      if (site.error) throw new Error(site.error.message);
      const db = await pgClient();
      try {
        await db.query(
          `insert into public.crew_punch_batches (
             organisation_id, kind, site_id, recorded_by_user, client_batch_id, device_time,
             recorded_at, time_source, worker_count, geofence_result, payload_hash
           ) values ($1, 'in', $2, $3, $4, now(), now(), 'elapsed', 1, 'unknown', md5('seed'))`,
          [side.orgId, (site.data as { id: string }).id, side.id, randomUUID()],
        );
      } finally {
        await db.end();
      }
    },
    rowOf: async ({ admin, side }) => {
      const { data, error } = await admin
        .from("crew_punch_batches")
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
      kind: "in",
      site_id: randomUUID(),
      recorded_by_user: randomUUID(),
      client_batch_id: randomUUID(),
      device_time: "2026-12-01T05:00:00Z",
      recorded_at: "2026-12-01T05:00:00Z",
      time_source: "device",
      worker_count: 1,
      geofence_result: "inside",
      payload_hash: "0".repeat(32),
    }),
    patch: { geofence_result: "inside" },
  },
];
