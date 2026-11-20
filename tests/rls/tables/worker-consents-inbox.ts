/**
 * Isolation registry for worker consents and the worker inbox (slice 3.1). Named so it loads
 * after people.ts, whose workers the seeds point at. The tenant users are owners, who may read
 * both tables (inbox read-only); the worker's own access is tested in worker-consents-inbox.test.ts.
 */
import { randomUUID } from "node:crypto";

import type { TableSpec } from "../helpers/registry";
import { pgClient, type Client } from "../helpers/supabase";

async function firstId(
  admin: Client,
  table: "workers" | "worker_consents" | "inbox_items",
  orgId: string,
): Promise<string> {
  const { data, error } = await admin
    .from(table)
    .select("id")
    .eq("organisation_id", orgId)
    .order("id")
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
    table: "worker_consents",
    ...byOrg,
    seed: async ({ admin, side }) => {
      // Not even the secret key may record a consent, so the seed writes as the database owner.
      const workerId = await firstId(admin, "workers", side.orgId);
      const db = await pgClient();
      try {
        await db.query(
          "insert into public.worker_consents (organisation_id, worker_id, kind, notice_version) values ($1, $2, 'location', '1.0')",
          [side.orgId, workerId],
        );
      } finally {
        await db.end();
      }
    },
    rowOf: ({ admin, side }) => firstId(admin, "worker_consents", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      worker_id: randomUUID(),
      kind: "selfie",
      notice_version: "1.0",
    }),
    patch: { withdrawn_at: new Date().toISOString() },
  },
  {
    table: "inbox_items",
    ...byOrg,
    seed: async ({ admin, side }) => {
      const workerId = await firstId(admin, "workers", side.orgId);
      const { error } = await admin.from("inbox_items").insert({
        organisation_id: side.orgId,
        worker_id: workerId,
        kind: "general",
        title: "Welcome",
        body: "Your company uses Metalira Ops for shifts.",
        link_path: "/m",
      });
      if (error) throw new Error(error.message);
    },
    rowOf: ({ admin, side }) => firstId(admin, "inbox_items", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      worker_id: randomUUID(),
      kind: "general",
      title: "Pay me",
      body: "Send your PIN to HR.",
    }),
    patch: { read_at: new Date().toISOString() },
  },
];
