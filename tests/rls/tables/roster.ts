/**
 * Isolation registry for slice 3.2 (the roster). Loads after business.ts (whose `posts` seed
 * gives each organisation a live contract with Gate A · Day, every day from 1 Nov 2026) and
 * people.ts (a worker). Rows are written with the secret key; no signed-in role has write grants
 * (assign_worker_to_shift and the other roster functions write them), and the guards check them.
 */
import { randomUUID } from "node:crypto";

import { addDays, lagosToday } from "@/lib/dates";

import type { TableSpec } from "../helpers/registry";
import type { Client } from "../helpers/supabase";

const SHIFT_DATE = addDays(lagosToday(), 7);

async function firstRow<T>(
  admin: Client,
  table: "shifts" | "shift_assignments" | "posts" | "workers",
  orgId: string,
  columns: string,
): Promise<T> {
  const { data, error } = await admin
    .from(table)
    .select(columns)
    .eq("organisation_id", orgId)
    .order("created_at")
    .limit(1)
    .single();
  if (error) throw new Error(error.message);
  return data as T;
}

export const tables: TableSpec[] = [
  {
    table: "shifts",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ admin, side }) => {
      const post = await firstRow<{ id: string; contract_id: string; site_id: string }>(
        admin,
        "posts",
        side.orgId,
        "id, contract_id, site_id",
      );
      // The guard fills the times and people from the requirement in force.
      const { error } = await admin.from("shifts").insert({
        organisation_id: side.orgId,
        post_id: post.id,
        contract_id: post.contract_id,
        site_id: post.site_id,
        shift_date: SHIFT_DATE,
        starts_at: new Date().toISOString(),
        ends_at: new Date(Date.now() + 60_000).toISOString(),
        required_count: 1,
      });
      if (error) throw new Error(error.message);
    },
    rowOf: async ({ admin, side }) =>
      (await firstRow<{ id: string }>(admin, "shifts", side.orgId, "id")).id,
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      post_id: randomUUID(),
      contract_id: randomUUID(),
      site_id: randomUUID(),
      shift_date: SHIFT_DATE,
      starts_at: "2026-12-01T05:00:00Z",
      ends_at: "2026-12-01T17:00:00Z",
      required_count: 1,
    }),
    patch: { status: "cancelled" },
  },
  {
    table: "shift_assignments",
    key: "id",
    // removed_reason, assigned_by and removed_by aren't granted (workers must not see them);
    // managers read them through roster_assignment_details.
    selectColumns:
      "id, organisation_id, shift_id, site_id, shift_date, worker_id, starts_at, ends_at, status, assigned_at, removed_at, created_at",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ admin, side }) => {
      const shift = await firstRow<{ id: string; site_id: string; shift_date: string }>(
        admin,
        "shifts",
        side.orgId,
        "id, site_id, shift_date",
      );
      const worker = await firstRow<{ id: string }>(admin, "workers", side.orgId, "id");
      const { error } = await admin.from("shift_assignments").insert({
        organisation_id: side.orgId,
        shift_id: shift.id,
        site_id: shift.site_id,
        shift_date: shift.shift_date,
        worker_id: worker.id,
        starts_at: new Date().toISOString(),
        ends_at: new Date(Date.now() + 60_000).toISOString(),
      });
      if (error) throw new Error(error.message);
    },
    rowOf: async ({ admin, side }) =>
      (await firstRow<{ id: string }>(admin, "shift_assignments", side.orgId, "id")).id,
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      shift_id: randomUUID(),
      site_id: randomUUID(),
      shift_date: SHIFT_DATE,
      worker_id: randomUUID(),
      starts_at: "2026-12-01T05:00:00Z",
      ends_at: "2026-12-01T17:00:00Z",
    }),
    patch: { status: "removed" },
  },
];
