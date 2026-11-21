/**
 * Isolation registry for queries and their replies (slice 4.6). Named so it loads after
 * people.ts, whose workers the seeds point at. The tenant users are owners, who read every query
 * in their company. No signed-in role may insert, update or delete either table (the SQL
 * functions write them), so every direct attack is refused. Rows are seeded with the secret key,
 * which may insert but never change or delete. Who reads which query, and the insert-only rules,
 * are tested in queries.test.ts.
 */
import { randomUUID } from "node:crypto";

import { addDays, lagosToday } from "@/lib/dates";

import type { TableSpec } from "../helpers/registry";
import type { Client } from "../helpers/supabase";

async function firstId(
  admin: Client,
  table: "workers" | "staff_queries" | "staff_query_replies",
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

const REPLY_BY = addDays(lagosToday(), 3);

export const tables: TableSpec[] = [
  {
    table: "staff_queries",
    ...byOrg,
    seed: async ({ admin, side }) => {
      const workerId = await firstId(admin, "workers", side.orgId);
      const { error } = await admin.from("staff_queries").insert({
        organisation_id: side.orgId,
        worker_id: workerId,
        raised_by: side.id,
        raised_by_name: "Kola Adebayo",
        kind: "lateness",
        subject: "Lateness on 23 October",
        body: "You clocked in at 06:41 for your 06:00 shift at Gate A. Please explain.",
        reply_by: REPLY_BY,
      });
      if (error) throw new Error(error.message);
    },
    rowOf: ({ admin, side }) => firstId(admin, "staff_queries", side.orgId),
    attackInsert: ({ attacker, victim }) => ({
      organisation_id: victim.orgId,
      worker_id: randomUUID(),
      raised_by: attacker.id,
      raised_by_name: "Attacker",
      kind: "conduct",
      subject: "Planted query",
      body: "This should never be stored.",
      reply_by: REPLY_BY,
    }),
    patch: { status: "closed" },
  },
  {
    table: "staff_query_replies",
    ...byOrg,
    seed: async ({ admin, side }) => {
      const queryId = await firstId(admin, "staff_queries", side.orgId);
      const { error } = await admin.from("staff_query_replies").insert({
        organisation_id: side.orgId,
        query_id: queryId,
        author_user_id: side.id,
        author_role: "worker",
        author_name: "Musa Ibrahim",
        body: "The BRT was stopped at Mile 2 because of an accident.",
      });
      if (error) throw new Error(error.message);
    },
    rowOf: ({ admin, side }) => firstId(admin, "staff_query_replies", side.orgId),
    attackInsert: ({ attacker, victim }) => ({
      organisation_id: victim.orgId,
      query_id: randomUUID(),
      author_user_id: attacker.id,
      author_role: "manager",
      author_name: "Attacker",
      body: "Planted reply.",
    }),
    patch: { body: "Edited reply." },
  },
];
