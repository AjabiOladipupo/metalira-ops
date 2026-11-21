/**
 * Isolation registry for slice 4.4 (leave requests and balances), on a worker and a leave type
 * made here. Rows are seeded with the secret key, which may insert but never change, delete or
 * truncate; signed-in roles have no write grants (the SQL functions write), and the triggers
 * refuse changes and deletes from everyone, the database owner included.
 */
import { randomUUID } from "node:crypto";

import type { TableSpec } from "../helpers/registry";
import type { Client } from "../helpers/supabase";

type Table = "leave_requests" | "leave_decisions" | "leave_ledger" | "manager_emails";

async function firstId(admin: Client, table: Table, orgId: string): Promise<string> {
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

/** A worker and a leave type of the organisation's own, with one request, decision and grant. */
async function seed(admin: Client, orgId: string, ownerId: string): Promise<void> {
  const worker = await admin
    .from("workers")
    .insert({
      organisation_id: orgId,
      staff_id: `LVR-${randomUUID().slice(0, 8)}`,
      first_name: "Isolation",
      last_name: "Leaver",
      employment_type: "permanent",
      start_date: "2025-01-06",
    })
    .select("id")
    .single();
  if (worker.error) throw new Error(worker.error.message);
  const type = await admin
    .from("leave_types")
    .insert({ organisation_id: orgId, code: `iso_${randomUUID().slice(0, 6)}`, name: `Isolation ${randomUUID().slice(0, 6)}` })
    .select("id")
    .single();
  if (type.error) throw new Error(type.error.message);
  const request = await admin
    .from("leave_requests")
    .insert({
      organisation_id: orgId,
      worker_id: worker.data.id,
      leave_type_id: type.data.id,
      leave_year: 2030,
      start_date: "2030-03-04",
      end_date: "2030-03-06",
      days: 3,
      pay_percent: 100,
    })
    .select("id")
    .single();
  if (request.error) throw new Error(request.error.message);
  const decision = await admin.from("leave_decisions").insert({
    organisation_id: orgId,
    request_id: request.data.id,
    worker_id: worker.data.id,
    step: "line_manager",
    decision: "approved",
    days: 3,
    actor: ownerId,
  });
  if (decision.error) throw new Error(decision.error.message);
  const grant = await admin.from("leave_ledger").insert({
    organisation_id: orgId,
    worker_id: worker.data.id,
    leave_type_id: type.data.id,
    leave_year: 2030,
    kind: "grant",
    days: 15,
  });
  if (grant.error) throw new Error(grant.error.message);
  const email = await admin.from("manager_emails").insert({
    organisation_id: orgId,
    kind: "leave_line_manager",
    ref_id: request.data.id,
    recipients: 1,
  });
  if (email.error) throw new Error(email.error.message);
}

export const tables: TableSpec[] = [
  {
    table: "leave_requests",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ admin, side }) => seed(admin, side.orgId, side.id),
    rowOf: async ({ admin, side }) => firstId(admin, "leave_requests", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      worker_id: randomUUID(),
      leave_type_id: randomUUID(),
      leave_year: 2030,
      start_date: "2030-05-04",
      end_date: "2030-05-04",
      days: 1,
      pay_percent: 100,
    }),
    patch: { status: "approved" },
  },
  {
    // Seeded with the request above (leave_requests loads first in this file).
    table: "leave_decisions",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    rowOf: async ({ admin, side }) => firstId(admin, "leave_decisions", side.orgId),
    attackInsert: ({ victim, attacker }) => ({
      organisation_id: victim.orgId,
      request_id: randomUUID(),
      worker_id: randomUUID(),
      step: "hr",
      decision: "approved",
      days: 1,
      actor: attacker.id,
    }),
    patch: { note: "Changed" },
  },
  {
    table: "leave_ledger",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    rowOf: async ({ admin, side }) => firstId(admin, "leave_ledger", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      worker_id: randomUUID(),
      leave_type_id: randomUUID(),
      leave_year: 2030,
      kind: "adjustment",
      days: 30,
      reason: "Attack",
    }),
    patch: { days: 99 },
  },
  {
    table: "manager_emails",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    rowOf: async ({ admin, side }) => firstId(admin, "manager_emails", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      kind: "leave_hr",
      ref_id: randomUUID(),
      recipients: 1,
    }),
    patch: { recipients: 9 },
  },
];
