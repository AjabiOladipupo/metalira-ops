/**
 * Slice 5.7c (security review M1): audit actions that definer functions read as evidence can't be
 * written by hand through public.log_audit, by any manager role. Their own functions still write
 * them (the rest of the suite downloads, releases and records through those).
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/types/db";

import {
  adminClient,
  createTenantUser,
  createTestUser,
  pgClient,
  type Client,
  type TenantUser,
  type TestUser,
} from "./helpers/supabase";

type Role = Database["public"]["Enums"]["membership_role"];

const RESERVED = [
  ["payroll.bank_file_downloaded", "payout_batches"],
  ["payroll.supplementary_file_downloaded", "payout_supplements"],
  ["payroll.instalment_not_carried", "payroll_runs"],
  ["payroll.results_saved", "payroll_runs"],
  ["payroll.run_created", "payroll_runs"],
  ["payroll.run_submitted", "payroll_runs"],
  ["payroll.adjustment_added", "payroll_runs"],
  ["payroll.adjustment_removed", "payroll_runs"],
  ["payroll.anomalies_acknowledged", "payroll_runs"],
  ["payroll.instalment_carried", "payroll_runs"],
  ["worker_auth.locked", "workers"],
  ["people.bank_details_single_approver", "workers"],
] as const;

let admin: Client;
let owner: TenantUser;
const people: Partial<Record<Role, TestUser>> = {};

beforeAll(async () => {
  admin = adminClient();
  owner = await createTenantUser("aud-owner", "Audit Reserved Org");
  for (const role of ["line_manager", "ops_manager", "hr", "finance"] as const) {
    const user = await createTestUser(`aud-${role}`);
    const { error } = await admin
      .from("memberships")
      .insert({ organisation_id: owner.orgId, user_id: user.id, role });
    expect(error).toBeNull();
    people[role] = user;
  }
});

afterAll(async () => {
  const db = await pgClient();
  await db.end();
});

describe("evidence audit events are written only by their own changes", () => {
  it("refuses every reserved action through log_audit, for every manager role", async () => {
    const callers: Client[] = [owner.client, ...Object.values(people).map((p) => p!.client)];
    for (const client of callers) {
      for (const [action, entity] of RESERVED) {
        const { error } = await client.rpc("log_audit", {
          p_organisation_id: owner.orgId,
          p_action: action,
          p_entity: entity,
          p_entity_id: randomUUID(),
          p_after: { worker_id: "not-a-uuid", instalment: "x" },
        });
        expect(error?.code, action).toBe("42501");
      }
    }
    const { data } = await admin
      .from("audit_log")
      .select("id")
      .eq("organisation_id", owner.orgId)
      .in(
        "action",
        RESERVED.map(([a]) => a),
      );
    expect(data).toEqual([]);
  });

  it("still writes an ordinary app event", async () => {
    const { error } = await people.hr!.client.rpc("log_audit", {
      p_organisation_id: owner.orgId,
      p_action: "payroll.schedule_downloaded",
      p_entity: "statutory_remittances",
      p_entity_id: randomUUID(),
    });
    expect(error).toBeNull();
  });

  it("reads instalments not carried as an empty list when nothing real is there", async () => {
    const { data, error } = await people.finance!.client.rpc("payroll_instalments_not_carried", {
      p_organisation_id: owner.orgId,
    });
    expect(error).toBeNull();
    expect(data).toEqual([]);
    const lm = await people.line_manager!.client.rpc("payroll_instalments_not_carried", {
      p_organisation_id: owner.orgId,
    });
    expect(lm.error?.code).toBe("42501");
  });
});
