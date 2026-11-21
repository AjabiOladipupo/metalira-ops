/**
 * Isolation registry for slice 4.3 (timesheet_decisions, work_units). Nobody, the secret key
 * included, has write grants on these tables (the approval functions write them), so the seed
 * inserts as the database owner, with triggers off for the transaction only
 * (session_replication_role = replica) so the Work Unit can name a post, shift and contract
 * without building a whole roster; the approval rules have their own suite
 * (tests/rls/timesheet-approval.test.ts). One worker made here, one no-shift line, one approved
 * decision and one Work Unit per side.
 */
import { randomUUID } from "node:crypto";

import type { TableSpec } from "../helpers/registry";
import { pgClient, type Client } from "../helpers/supabase";

const WORK_DATE = "2026-11-11";

async function seedApproval(admin: Client, orgId: string, actor: string): Promise<void> {
  const { data, error } = await admin
    .from("workers")
    .insert({
      organisation_id: orgId,
      staff_id: `TA-${randomUUID().slice(0, 8)}`,
      first_name: "Isolation",
      last_name: "Approval",
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
    await db.query("set local session_replication_role = replica");
    const punch = randomUUID();
    await db.query(
      `insert into public.punches (
         id, organisation_id, worker_id, kind, recorded_by_user, client_event_id, device_time,
         recorded_at, received_at, time_source, clock_drift_seconds, geofence_result, flags, payload_hash
       ) values ($1, $2, $3, 'in', $4, $5, '2026-11-11T07:00:00Z', '2026-11-11T07:00:00Z',
         '2026-11-11T07:00:00Z', 'elapsed', 0, 'unknown', array['no_shift'], md5('ta-seed'))`,
      [punch, orgId, worker, actor, randomUUID()],
    );
    const sheet = randomUUID();
    await db.query(
      `insert into public.timesheets (id, organisation_id, worker_id, period_start, period_end)
       values ($1, $2, $3, '2026-10-20', '2026-11-19')`,
      [sheet, orgId, worker],
    );
    const line = randomUUID();
    await db.query(
      `insert into public.timesheet_lines (
         id, organisation_id, timesheet_id, worker_id, work_date, no_shift_punch_id, in_punch_id,
         worked_minutes, status
       ) values ($1, $2, $3, $4, $5, $6, $6, 480, 'approved')`,
      [line, orgId, sheet, worker, WORK_DATE, punch],
    );
    const decision = randomUUID();
    await db.query(
      `insert into public.timesheet_decisions (
         id, organisation_id, line_id, worker_id, decision, actor_id, scheduled_minutes,
         worked_minutes, late_minutes, early_minutes, ot_minutes
       ) values ($1, $2, $3, $4, 'approved', $5, 480, 480, 0, 0, 0)`,
      [decision, orgId, line, worker, actor],
    );
    await db.query(
      `insert into public.work_units (
         organisation_id, contract_id, site_id, post_id, shift_id, timesheet_line_id, worker_id,
         work_date, unit, quantity_minutes, contract_type, billable, approved_decision_id
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'shift', 480, 'manned_post', true, $9)`,
      [
        orgId,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        line,
        worker,
        WORK_DATE,
        decision,
      ],
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
  table: "timesheet_decisions" | "work_units",
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
    table: "timesheet_decisions",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ admin, side }) => seedApproval(admin, side.orgId, side.id),
    rowOf: async ({ admin, side }) => firstId(admin, "timesheet_decisions", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      line_id: randomUUID(),
      worker_id: randomUUID(),
      decision: "approved",
      scheduled_minutes: 0,
      worked_minutes: 0,
      late_minutes: 0,
      early_minutes: 0,
      ot_minutes: 0,
    }),
    patch: { reason: "Changed" },
  },
  {
    table: "work_units",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    rowOf: async ({ admin, side }) => firstId(admin, "work_units", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      contract_id: randomUUID(),
      site_id: randomUUID(),
      post_id: randomUUID(),
      shift_id: randomUUID(),
      timesheet_line_id: randomUUID(),
      worker_id: randomUUID(),
      work_date: WORK_DATE,
      unit: "shift",
      quantity_minutes: 480,
      contract_type: "manned_post",
      billable: true,
      approved_decision_id: randomUUID(),
    }),
    patch: { quantity_minutes: 720 },
  },
];
