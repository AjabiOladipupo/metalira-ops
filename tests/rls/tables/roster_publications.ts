/**
 * Isolation registry for slice 3.3 (roster publishing). Loads after business.ts (each
 * organisation has a site). Rows are written with the secret key; no signed-in role has write
 * grants (publish_roster writes them) and the guard refuses every update and delete.
 */
import { randomUUID } from "node:crypto";

import { addDays, lagosToday } from "@/lib/dates";
import { isoWeekday } from "@/lib/headcount";

import type { TableSpec } from "../helpers/registry";
import type { Client } from "../helpers/supabase";

const today = lagosToday();
const WEEK = addDays(today, 8 - isoWeekday(today));

async function firstId(
  admin: Client,
  table: "sites" | "roster_publications",
  orgId: string,
): Promise<string> {
  const { data, error } = await admin
    .from(table)
    .select("id")
    .eq("organisation_id", orgId)
    .limit(1)
    .single();
  if (error) throw new Error(error.message);
  return data.id;
}

export const tables: TableSpec[] = [
  {
    table: "roster_publications",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ admin, side }) => {
      const siteId = await firstId(admin, "sites", side.orgId);
      const { error } = await admin.from("roster_publications").insert({
        organisation_id: side.orgId,
        site_id: siteId,
        week_start: WEEK,
        version: 1,
        snapshot: [],
      });
      if (error) throw new Error(error.message);
    },
    rowOf: async ({ admin, side }) => firstId(admin, "roster_publications", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      site_id: randomUUID(),
      week_start: WEEK,
      version: 9,
      snapshot: [],
    }),
    patch: { assigned_count: 99 },
  },
];
