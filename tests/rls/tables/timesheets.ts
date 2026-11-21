/**
 * Isolation registry for slice 4.2 (timesheets, timesheet_lines, timesheet_corrections), on a
 * worker made here for it (a line is a work record, and the staff ID registry corrects the
 * organisation's first worker, which must have none). Nobody, the secret key included, has write
 * grants on these tables (refresh_timesheet_lines and add_timesheet_correction write them), so the
 * seed inserts as the database owner: one no-shift clock-in, its timesheet, its line and one
 * correction.
 */
import { randomUUID } from "node:crypto";

import type { TableSpec } from "../helpers/registry";
import { pgClient, type Client } from "../helpers/supabase";

const WORK_DATE = "2026-11-10";

async function seedTimesheet(admin: Client, orgId: string, actor: string): Promise<void> {
  const { data, error } = await admin
    .from("workers")
    .insert({
      organisation_id: orgId,
      staff_id: `TS-${randomUUID().slice(0, 8)}`,
      first_name: "Isolation",
      last_name: "Timesheet",
      employment_type: "permanent",
      start_date: "2025-01-06",
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const worker = data.id;
  const db = await pgClient();
  try {
    await db.query("begin");
    const punch = await db.query<{ id: string }>(
      `insert into public.punches (
         organisation_id, worker_id, kind, recorded_by_user, client_event_id, device_time,
         recorded_at, received_at, time_source, clock_drift_seconds, geofence_result, flags, payload_hash
       ) values ($1, $2, 'in', $3, $4, '2026-11-10T07:00:00Z', '2026-11-10T07:00:00Z',
         '2026-11-10T07:00:00Z', 'elapsed', 0, 'unknown', array['no_shift'], md5('ts-seed'))
       returning id`,
      [orgId, worker, actor, randomUUID()],
    );
    const sheet = await db.query<{ id: string }>(
      `insert into public.timesheets (organisation_id, worker_id, period_start, period_end)
       values ($1, $2, '2026-10-20', '2026-11-19') returning id`,
      [orgId, worker],
    );
    const line = await db.query<{ id: string }>(
      `insert into public.timesheet_lines (
         organisation_id, timesheet_id, worker_id, work_date, no_shift_punch_id, in_punch_id,
         exceptions
       ) values ($1, $2, $3, $4, $5, $5, array['no_shift', 'no_clock_out']) returning id`,
      [orgId, sheet.rows[0]!.id, worker, WORK_DATE, punch.rows[0]!.id],
    );
    await db.query(
      `insert into public.timesheet_corrections (
         organisation_id, line_id, worker_id, kind, corrected_at, reason, actor_id
       ) values ($1, $2, $3, 'set_clock_out', '2026-11-10T18:00:00Z', 'Gate book shows 19:00', $4)`,
      [orgId, line.rows[0]!.id, worker, actor],
    );
    await db.query("commit");
  } catch (e) {
    await db.query("rollback");
    throw e;
  } finally {
    await db.end();
  }
}

async function firstId(
  admin: Client,
  table: "timesheets" | "timesheet_lines" | "timesheet_corrections",
  orgId: string,
): Promise<string> {
  const { data, error } = await admin
    .from(table)
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
    table: "timesheets",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ admin, side }) => seedTimesheet(admin, side.orgId, side.id),
    rowOf: async ({ admin, side }) => firstId(admin, "timesheets", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      worker_id: randomUUID(),
      period_start: "2026-11-20",
      period_end: "2026-12-19",
    }),
    patch: { period_end: "2026-12-20" },
  },
  {
    table: "timesheet_lines",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    rowOf: async ({ admin, side }) => firstId(admin, "timesheet_lines", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      timesheet_id: randomUUID(),
      worker_id: randomUUID(),
      work_date: WORK_DATE,
      no_shift_punch_id: randomUUID(),
    }),
    patch: { worked_minutes: 720 },
  },
  {
    table: "timesheet_corrections",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    rowOf: async ({ admin, side }) => firstId(admin, "timesheet_corrections", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      line_id: randomUUID(),
      worker_id: randomUUID(),
      kind: "set_minutes",
      minutes: 720,
      reason: "Planted",
    }),
    patch: { reason: "Changed" },
  },
];
