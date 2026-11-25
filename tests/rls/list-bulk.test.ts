/**
 * Slice U.2 bulk actions on the lists, against the real database:
 * - Leave: public.bulk_approve_leave approves each request at the step the caller decides,
 *   through the single decisions, and SKIPS (never fails) the caller's own leave, requests
 *   outside their scope (no name for a line manager), a certificate nobody has seen and anything
 *   the single decision refuses. The dry run writes nothing. One audit row per decision and one
 *   for the batch. Another company's ids refuse the whole batch (MLLB2).
 * - Timesheets: "Approve selected" (4.3's approve_clean_timesheet_lines behind the U.2 selection
 *   guard) approves clean days and skips flagged ones, the caller's own and other people's.
 * - The digest guard: a confirm whose selection isn't the preview's is refused (MLLB3).
 * - Worker invites: bulk resend emails only workers whose last invite wasn't used, within the
 *   email caps (past a cap, skipped and listed); bulk cancel revokes open invites. Audited per
 *   invite and per batch. Owner, admin and hr only.
 * - Untrusted sessions get 42501 from every function.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays, lagosToday } from "@/lib/dates";
import { ListChanged, NotInList } from "@/server/identity/bulk-selection";
import { bulkApproveLeaveSpec, previewBulkLeaveSpec } from "@/server/people/leave-bulk";
import {
  bulkApproveTimesheetSpec,
  previewBulkTimesheetSpec,
} from "@/server/workforce/timesheet-bulk";
import type { Database } from "@/types/db";

import {
  adminClient,
  anonClient,
  createTenantUser,
  createTestUser,
  pgClient,
  type Client,
  type TenantUser,
  type TestUser,
} from "./helpers/supabase";

type Role = Database["public"]["Enums"]["membership_role"];

const DENIED = "42501";
const PIN_HASH = `s1$k1$${"A".repeat(22)}$${"B".repeat(43)}`;
const CENTRE = "SRID=4326;POINT(3.3611 6.4474)";
const DAY = addDays(lagosToday(), -3);
const at = (day: string, time: string) => Date.parse(`${day}T${time}:00+01:00`);

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
const staff = {} as Record<"hr" | "ops" | "lineManager", TestUser>;
let lmOwnWorker: string;
let site: string;
let annual: string;
let sick: string;
let today: string;
let start: string;
let roomInYear = true;
let counter = 0;

async function addMember(user: TestUser, role: Role, orgId = owner.orgId, workerId?: string) {
  const { data, error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role, worker_id: workerId ?? null })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

async function addWorker(
  extra: Partial<Database["public"]["Tables"]["workers"]["Insert"]> = {},
  orgId = owner.orgId,
): Promise<string> {
  counter += 1;
  const { data, error } = await admin
    .from("workers")
    .insert({
      organisation_id: orgId,
      staff_id: `LB-${String(counter).padStart(4, "0")}-${randomUUID().slice(0, 4)}`,
      first_name: "Bisi",
      last_name: `Bulk ${counter}`,
      employment_type: "permanent",
      start_date: "2025-01-06",
      ...extra,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

/** An invited worker with a session opened the way the server does it. */
async function workerSession(workerId: string, orgId = owner.orgId, inviter: TestUser = staff.hr) {
  const invite = await inviter.client.rpc("create_worker_invites", {
    p_organisation_id: orgId,
    p_worker_ids: [workerId],
    p_sent_via: "print",
  });
  expect(invite.error).toBeNull();
  const email = `w-${workerId}@workers.metalira.invalid`;
  const login = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    app_metadata: { login: "worker" },
  });
  expect(login.error).toBeNull();
  const accepted = await admin.rpc("accept_worker_invite", {
    p_token: invite.data![0]!.token,
    p_auth_user_id: login.data.user!.id,
    p_pin_hash: PIN_HASH,
  });
  expect(accepted.error).toBeNull();
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  expect(link.error).toBeNull();
  const client = anonClient();
  const verified = await client.auth.verifyOtp({
    type: "email",
    token_hash: link.data.properties!.hashed_token,
  });
  expect(verified.error).toBeNull();
  return client;
}

function plus(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The next Monday at least a week ahead. */
function mondayAhead(): string {
  const d = new Date(`${today}T00:00:00Z`);
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (8 - dow) + 7);
  return d.toISOString().slice(0, 10);
}

async function requestLeave(
  client: Client,
  typeId: string,
  from: string,
  to: string,
  orgId = owner.orgId,
): Promise<string> {
  const { data, error } = await client.rpc("request_leave", {
    p_organisation_id: orgId,
    p_leave_type_id: typeId,
    p_start_date: from,
    p_end_date: to,
  });
  expect(error).toBeNull();
  return (data as { id: string }).id;
}

async function leaveStatus(id: string): Promise<string> {
  const { rows } = await db.query<{ status: string }>(
    "select status from public.leave_requests where id = $1",
    [id],
  );
  return rows[0]!.status;
}

interface BulkLeave {
  approved: { id: string; step: string; status: string }[];
  skipped: { id: string; code: string; reason: string | null; worker_name: string | null }[];
}

function bulkLeave(client: Client, ids: string[], dryRun = false, orgId = owner.orgId) {
  return client.rpc("bulk_approve_leave", {
    p_organisation_id: orgId,
    p_request_ids: ids,
    p_dry_run: dryRun,
  });
}

async function auditCount(action: string, orgId = owner.orgId): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    "select count(*)::int as n from public.audit_log where organisation_id = $1 and action = $2",
    [orgId, action],
  );
  return rows[0]!.n;
}

// --- Timesheet seeding (as tests/rls/timesheet-approval.test.ts) ---------------------------

async function addSite(orgId: string, name: string): Promise<string> {
  const { data: clientId, error } = await admin.rpc("create_client", {
    p_organisation_id: orgId,
    p_name: `${name} client`,
    p_contact_name: "Ngozi Eze",
    p_contact_email: "accounts@client.example",
  });
  expect(error).toBeNull();
  const row = await admin
    .from("sites")
    .insert({ organisation_id: orgId, client_id: clientId!, name, centre: CENTRE } as never)
    .select("id")
    .single();
  expect(row.error).toBeNull();
  return row.data!.id;
}

/** A manned-post contract, post, shift and assignment, triggers off. */
async function rostered(workerId: string, day: string): Promise<string> {
  const [contract, post, shift, assignment] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  const startsAt = new Date(at(day, "07:00"));
  const endsAt = new Date(at(day, "19:00"));
  await db.query("begin");
  try {
    await db.query("set local session_replication_role = replica");
    await db.query(
      `insert into public.contracts (id, organisation_id, client_id, reference, name, type, start_date, vat_applies, status)
       values ($1, $2, $3, $4, 'Guarding', 'manned_post', '2025-01-01', false, 'active')`,
      [contract, owner.orgId, randomUUID(), `LB-${contract.slice(0, 8)}`],
    );
    await db.query(
      `insert into public.posts (id, organisation_id, contract_id, site_id, name, role, band, unit, opened_on)
       values ($1, $2, $3, $4, $5, 'Guard', 'Day', 'shift', $6)`,
      [post, owner.orgId, contract, site, `Gate ${post.slice(0, 6)} · Day`, day],
    );
    await db.query(
      `insert into public.shifts (id, organisation_id, post_id, contract_id, site_id, shift_date, starts_at, ends_at, required_count)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 1)`,
      [shift, owner.orgId, post, contract, site, day, startsAt, endsAt],
    );
    await db.query(
      `insert into public.shift_assignments (id, organisation_id, shift_id, site_id, shift_date, worker_id, starts_at, ends_at, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'assigned')`,
      [assignment, owner.orgId, shift, site, day, workerId, startsAt, endsAt],
    );
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
  return assignment;
}

async function punch(
  workerId: string,
  assignmentId: string,
  kind: "in" | "out",
  when: number,
  flags: string[] = [],
) {
  await db.query(
    `insert into public.punches (id, organisation_id, worker_id, kind, source, recorded_by_user, client_event_id,
       shift_assignment_id, site_id, device_time, received_at, recorded_at, time_source,
       clock_drift_seconds, geofence_result, flags, payload_hash, crew_batch_id, created_at)
     values ($1, $2, $3, $4, 'self', $5, $6, $7, $8, $9, $9, $9, 'elapsed', 0, 'inside', $10,
       md5(gen_random_uuid()::text), null, $9)`,
    [
      randomUUID(),
      owner.orgId,
      workerId,
      kind,
      randomUUID(),
      randomUUID(),
      assignmentId,
      site,
      new Date(when),
      flags,
    ],
  );
}

/** A finished 07:00 to 19:00 day on DAY; clean unless `flags` mark the clock-in. */
async function timesheetDay(workerId: string, flags: string[] = []): Promise<string> {
  const assignment = await rostered(workerId, DAY);
  await punch(workerId, assignment, "in", at(DAY, "07:00"), flags);
  await punch(workerId, assignment, "out", at(DAY, "19:00"));
  const res = await owner.client.rpc("refresh_timesheet_lines", {
    p_organisation_id: owner.orgId,
    p_from: DAY,
    p_to: DAY,
  });
  expect(res.error).toBeNull();
  const { rows } = await db.query<{ id: string }>(
    "select id from public.timesheet_lines where shift_assignment_id = $1",
    [assignment],
  );
  return rows[0]!.id;
}

async function lineStatus(id: string): Promise<string> {
  const { rows } = await db.query<{ status: string }>(
    "select status from public.timesheet_lines where id = $1",
    [id],
  );
  return rows[0]!.status;
}

beforeAll(async () => {
  // The preview digest is keyed with a subkey of the personal data key (any throwaway key here).
  process.env.PII_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("lb-owner", "List Bulk Org");
  other = await createTenantUser("lb-other", "Other List Bulk Org");
  staff.hr = await createTestUser("lb-hr");
  staff.ops = await createTestUser("lb-ops");
  staff.lineManager = await createTestUser("lb-lm", "Kola Adebayo");
  await addMember(staff.hr, "hr");
  await addMember(staff.ops, "ops_manager");
  lmOwnWorker = await addWorker();
  await addMember(staff.lineManager, "line_manager", owner.orgId, lmOwnWorker);
  site = await addSite(owner.orgId, "Bulk Gate");

  const preset = await owner.client.rpc("apply_leave_preset", {
    p_organisation_id: owner.orgId,
    p_preset: "B",
  });
  expect(preset.error).toBeNull();
  const types = await admin
    .from("leave_types")
    .select("id, code")
    .eq("organisation_id", owner.orgId);
  annual = types.data!.find((t) => t.code === "annual")!.id;
  sick = types.data!.find((t) => t.code === "sick")!.id;

  const { rows } = await db.query<{ today: string }>(
    "select private.org_today($1)::text as today",
    [owner.orgId],
  );
  today = rows[0]!.today;
  start = mondayAhead();
  // Every request here sits within 10 days of `start`, inside this leave year.
  roomInYear = plus(start, 10).slice(0, 4) === today.slice(0, 4);
});

afterAll(async () => {
  await db?.end();
});

describe("bulk approve leave", () => {
  it("approves the line manager's step for reportees and skips their own leave and others'", async () => {
    if (!roomInYear) return;
    const a = await addWorker({ line_manager_worker_id: lmOwnWorker });
    const b = await addWorker({ line_manager_worker_id: lmOwnWorker });
    const outsider = await addWorker();
    const [aReq, bReq, outsiderReq, ownReq] = await Promise.all([
      workerSession(a).then((c) => requestLeave(c, annual, start, plus(start, 2))),
      workerSession(b).then((c) => requestLeave(c, annual, start, plus(start, 2))),
      workerSession(outsider).then((c) => requestLeave(c, annual, start, plus(start, 2))),
      // The line manager's own leave, seeded as the database owner (their worker has no app login).
      db
        .query<{ id: string }>(
          `insert into public.leave_requests (organisation_id, worker_id, leave_type_id, leave_year,
             start_date, end_date, days)
           values ($1, $2, $3, $4, $5, $5, 1) returning id`,
          [owner.orgId, lmOwnWorker, annual, Number(today.slice(0, 4)), start],
        )
        .then((r) => r.rows[0]!.id),
    ]);
    const ids = [aReq, bReq, outsiderReq, ownReq];

    // The preview writes nothing.
    const batchesBefore = await auditCount("leave.bulk_approved");
    const dry = await bulkLeave(staff.lineManager.client, ids, true);
    expect(dry.error).toBeNull();
    const preview = dry.data as unknown as BulkLeave;
    expect(preview.approved.map((x) => x.id).sort()).toEqual([aReq, bReq].sort());
    expect(preview.approved.every((x) => x.step === "line_manager")).toBe(true);
    const skipped = Object.fromEntries(preview.skipped.map((s) => [s.id, s]));
    expect(skipped[ownReq]).toMatchObject({ code: "own" });
    // Out of the line manager's scope: skipped as not found, with no details.
    expect(skipped[outsiderReq]).toEqual({ id: outsiderReq, code: "not_found" });
    for (const id of ids) expect(await leaveStatus(id)).toBe("pending_line_manager");
    expect(await auditCount("leave.bulk_approved")).toBe(batchesBefore);

    // For real: the reportees move on to HR; the others stay put. Audited per decision and batch.
    const decidedBefore = await auditCount("leave.decided_line_manager");
    const real = await bulkLeave(staff.lineManager.client, ids);
    expect(real.error).toBeNull();
    expect((real.data as unknown as BulkLeave).approved).toHaveLength(2);
    expect(await leaveStatus(aReq)).toBe("pending_hr");
    expect(await leaveStatus(bReq)).toBe("pending_hr");
    expect(await leaveStatus(outsiderReq)).toBe("pending_line_manager");
    expect(await leaveStatus(ownReq)).toBe("pending_line_manager");
    expect(await auditCount("leave.decided_line_manager")).toBe(decidedBefore + 2);
    expect(await auditCount("leave.bulk_approved")).toBe(batchesBefore + 1);
  });

  it("approves HR's step and skips a certificate nobody has seen and a step HR doesn't decide", async () => {
    if (!roomInYear) return;
    const w = await addWorker();
    const client = await workerSession(w);
    const annualReq = await requestLeave(client, annual, start, plus(start, 1));
    const sickReq = await requestLeave(client, sick, plus(start, 7), plus(start, 7));
    // No line manager: an ops manager decides step 1 for both.
    const step1 = await bulkLeave(staff.ops.client, [annualReq, sickReq]);
    expect(step1.error).toBeNull();
    expect(await leaveStatus(annualReq)).toBe("pending_hr");
    expect(await leaveStatus(sickReq)).toBe("pending_hr");

    // Ops can't decide step 2: both skipped.
    const ops = (await bulkLeave(staff.ops.client, [annualReq], true)).data as unknown as BulkLeave;
    expect(ops.approved).toHaveLength(0);
    expect(ops.skipped[0]).toMatchObject({ code: "not_yours" });

    const res = await bulkLeave(staff.hr.client, [annualReq, sickReq]);
    expect(res.error).toBeNull();
    const out = res.data as unknown as BulkLeave;
    expect(out.approved.map((x) => x.id)).toEqual([annualReq]);
    expect(out.approved[0]).toMatchObject({ step: "hr", status: "approved" });
    expect(out.skipped).toEqual([expect.objectContaining({ id: sickReq, code: "certificate" })]);
    expect(await leaveStatus(annualReq)).toBe("approved");
    expect(await leaveStatus(sickReq)).toBe("pending_hr");
  });

  it("skips what the single decision refuses (a short balance) and approves the rest", async () => {
    if (!roomInYear) return;
    const short = await addWorker();
    const fine = await addWorker();
    const shortReq = await requestLeave(await workerSession(short), annual, start, plus(start, 4));
    const fineReq = await requestLeave(await workerSession(fine), annual, start, start);
    await bulkLeave(staff.ops.client, [shortReq, fineReq]);
    // Leave the first worker 2 days, fewer than the 5 they asked for.
    const balance = await staff.hr.client.rpc("leave_balances", {
      p_organisation_id: owner.orgId,
      p_year: Number(today.slice(0, 4)),
      p_worker_ids: [short],
    });
    expect(balance.error).toBeNull();
    const left = balance.data!.find((b) => b.leave_type_id === annual)!.balance;
    const adjust = await staff.hr.client.rpc("adjust_leave_balance", {
      p_organisation_id: owner.orgId,
      p_worker_id: short,
      p_leave_type_id: annual,
      p_year: Number(today.slice(0, 4)),
      p_days: 2 - left,
      p_reason: "Taken before the system",
    });
    expect(adjust.error).toBeNull();
    const out = (await bulkLeave(staff.hr.client, [shortReq, fineReq]))
      .data as unknown as BulkLeave;
    expect(out.approved.map((x) => x.id)).toEqual([fineReq]);
    expect(out.skipped[0]).toMatchObject({ id: shortReq, code: "refused" });
    expect(out.skipped[0]!.reason).toMatch(/left, fewer than/);
    expect(await leaveStatus(shortReq)).toBe("pending_hr");
    expect(await leaveStatus(fineReq)).toBe("approved");
  });

  it("refuses another company's ids, and nothing changes", async () => {
    if (!roomInYear) return;
    const otherPreset = await other.client.rpc("apply_leave_preset", {
      p_organisation_id: other.orgId,
      p_preset: "B",
    });
    expect(otherPreset.error).toBeNull();
    const otherAnnual = (
      await admin.from("leave_types").select("id, code").eq("organisation_id", other.orgId)
    ).data!.find((t) => t.code === "annual")!.id;
    const foreignWorker = await addWorker({}, other.orgId);
    const foreignReq = await requestLeave(
      await workerSession(foreignWorker, other.orgId, other),
      otherAnnual,
      start,
      start,
      other.orgId,
    );
    const mine = await addWorker();
    const mineReq = await requestLeave(await workerSession(mine), annual, start, start);

    const res = await bulkLeave(owner.client, [mineReq, foreignReq]);
    expect(res.error?.code).toBe("MLLB2");
    expect(await leaveStatus(mineReq)).toBe("pending_line_manager");
    expect(await leaveStatus(foreignReq)).toBe("pending_line_manager");
    // And at the server, the selection guard refuses it before the database is asked.
    await expect(
      previewBulkLeaveSpec.run({
        supabase: owner.client,
        organisationId: owner.orgId,
        userId: owner.id,
        role: "owner",
        data: { requestIds: [mineReq, foreignReq] },
      }),
    ).rejects.toBeInstanceOf(NotInList);
  });

  it("refuses a confirm whose selection or act set isn't the preview's (the digest guard)", async () => {
    if (!roomInYear) return;
    const ctx = {
      supabase: owner.client,
      organisationId: owner.orgId,
      userId: owner.id,
      role: "owner" as const,
    };
    const x = await addWorker();
    const y = await addWorker();
    const xReq = await requestLeave(await workerSession(x), annual, start, start);
    const yReq = await requestLeave(await workerSession(y), annual, start, start);
    const preview = await previewBulkLeaveSpec.run({ ...ctx, data: { requestIds: [xReq] } });
    expect(preview.selection.count).toBe(1);
    expect(preview.selection.act).toEqual([xReq]);
    await expect(
      bulkApproveLeaveSpec.run({
        ...ctx,
        data: {
          requestIds: [xReq, yReq],
          actIds: [xReq],
          expectedDigest: preview.selection.digest,
        },
      }),
    ).rejects.toMatchObject({ refusal: "MLLB3" });
    // The digest is bound to the user: HR can't replay the owner's preview.
    await expect(
      bulkApproveLeaveSpec.run({
        ...ctx,
        supabase: staff.hr.client,
        userId: staff.hr.id,
        role: "hr",
        data: { requestIds: [xReq], actIds: [xReq], expectedDigest: preview.selection.digest },
      }),
    ).rejects.toMatchObject({ refusal: "MLLB3" });
    expect(await leaveStatus(xReq)).toBe("pending_line_manager");
    expect(await leaveStatus(yReq)).toBe("pending_line_manager");

    const done = await bulkApproveLeaveSpec.run({
      ...ctx,
      data: { requestIds: [xReq], actIds: [xReq], expectedDigest: preview.selection.digest },
    });
    expect(done.approved.map((a) => a.id)).toEqual([xReq]);
    expect(await leaveStatus(xReq)).toBe("pending_hr");
  });

  it("never approves requests the preview skipped, even once they pass (security review M1)", async () => {
    if (!roomInYear) return;
    const ctx = {
      supabase: staff.hr.client,
      organisationId: owner.orgId,
      userId: staff.hr.id,
      role: "hr" as const,
    };
    const [p, q, r] = [await addWorker(), await addWorker(), await addWorker()];
    const okReq = await requestLeave(await workerSession(p), annual, start, start);
    const sickA = await requestLeave(await workerSession(q), sick, start, start);
    const sickB = await requestLeave(await workerSession(r), sick, start, start);
    const ids = [okReq, sickA, sickB];
    // No line managers: ops decides step 1, so all three wait for HR.
    await bulkLeave(staff.ops.client, ids);
    for (const id of ids) expect(await leaveStatus(id)).toBe("pending_hr");

    const preview = await previewBulkLeaveSpec.run({ ...ctx, data: { requestIds: ids } });
    expect(preview.selection.act).toEqual([okReq]);
    expect(preview.skipped.map((s) => s.code).sort()).toEqual(["certificate", "certificate"]);

    // Both become clean before the confirm.
    await db.query(
      "update public.leave_requests set certificate_seen = true where id = any($1::uuid[])",
      [[sickA, sickB]],
    );

    // A confirm can't add them to the signed set...
    await expect(
      bulkApproveLeaveSpec.run({
        ...ctx,
        data: { requestIds: ids, actIds: ids, expectedDigest: preview.selection.digest },
      }),
    ).rejects.toMatchObject({ refusal: "MLLB3" });
    // ...and the honest confirm leaves them alone.
    const done = await bulkApproveLeaveSpec.run({
      ...ctx,
      data: {
        requestIds: ids,
        actIds: preview.selection.act,
        expectedDigest: preview.selection.digest,
      },
    });
    expect(done.approved.map((a) => a.id)).toEqual([okReq]);
    expect(done.notInPreview.sort()).toEqual([sickA, sickB].sort());
    expect(await leaveStatus(okReq)).toBe("approved");
    expect(await leaveStatus(sickA)).toBe("pending_hr");
    expect(await leaveStatus(sickB)).toBe("pending_hr");
  });

  it("skips a request the caller can't read as not found, with no details (security review L1)", async () => {
    if (!roomInYear) return;
    const stranger = await addWorker();
    const req = await requestLeave(await workerSession(stranger), annual, start, start);
    const res = await bulkLeave(staff.lineManager.client, [req], true);
    expect(res.error).toBeNull();
    const out = res.data as unknown as BulkLeave;
    expect(out.approved).toEqual([]);
    expect(out.skipped).toEqual([{ id: req, code: "not_found" }]);
  });

  it("refuses an empty batch and more than 500", async () => {
    expect((await bulkLeave(owner.client, [])).error?.code).toBe("MLLB1");
    const many = Array.from({ length: 501 }, () => randomUUID());
    expect((await bulkLeave(owner.client, many)).error?.code).toBe("MLLB1");
  });
});

describe("bulk approve timesheets", () => {
  it("approves clean days and skips flagged ones, the caller's own and other people's", async () => {
    const reportee = await addWorker({ line_manager_worker_id: lmOwnWorker });
    const flaggedWorker = await addWorker({ line_manager_worker_id: lmOwnWorker });
    const stranger = await addWorker();
    const clean = await timesheetDay(reportee);
    const flagged = await timesheetDay(flaggedWorker, ["no_selfie"]);
    const own = await timesheetDay(lmOwnWorker);
    const strangers = await timesheetDay(stranger);

    const res = await staff.lineManager.client.rpc("approve_clean_timesheet_lines", {
      p_organisation_id: owner.orgId,
      p_line_ids: [clean, flagged, own, strangers],
    });
    expect(res.error).toBeNull();
    const out = res.data as unknown as {
      approved: { line_id: string }[];
      refused: { line_id: string; code: string; worker_name?: string }[];
    };
    expect(out.approved.map((a) => a.line_id)).toEqual([clean]);
    const codes = Object.fromEntries(out.refused.map((r) => [r.line_id, r]));
    expect(codes[flagged]).toMatchObject({ code: "flagged" });
    expect(codes[own]).toMatchObject({ code: "own" });
    // Out of scope: skipped as not found, with no name.
    expect(codes[strangers]).toEqual({ line_id: strangers, code: "not_found" });
    expect(await lineStatus(clean)).toBe("approved");
    for (const id of [flagged, own, strangers]) expect(await lineStatus(id)).toBe("pending");
  });

  it("previews, then confirms only the days the preview would approve; another set is refused", async () => {
    const ctx = {
      supabase: owner.client,
      organisationId: owner.orgId,
      userId: owner.id,
      role: "owner" as const,
    };
    const days = [
      await timesheetDay(await addWorker()),
      await timesheetDay(await addWorker()),
      await timesheetDay(await addWorker()),
    ];
    const flagged = await timesheetDay(await addWorker(), ["no_selfie"]);
    const preview = await previewBulkTimesheetSpec.run({
      ...ctx,
      data: { period: DAY, lineIds: [...days, flagged] },
    });
    expect(preview.dryRun).toBe(true);
    expect(preview.approved.map((a) => a.lineId).sort()).toEqual([...days].sort());
    expect([...preview.selection.act].sort()).toEqual([...days].sort());
    expect(preview.refused).toEqual([
      expect.objectContaining({ lineId: flagged, code: "flagged" }),
    ]);
    for (const id of days) expect(await lineStatus(id)).toBe("pending");

    // Another ticked set, or the flagged day added to the signed set: refused, nothing changes.
    for (const data of [
      { period: DAY, lineIds: days, actIds: days },
      { period: DAY, lineIds: [...days, flagged], actIds: [...days, flagged] },
    ]) {
      await expect(
        bulkApproveTimesheetSpec.run({
          ...ctx,
          data: { ...data, expectedDigest: preview.selection.digest },
        }),
      ).rejects.toBeInstanceOf(ListChanged);
    }
    for (const id of [...days, flagged]) expect(await lineStatus(id)).toBe("pending");

    const done = await bulkApproveTimesheetSpec.run({
      ...ctx,
      data: {
        period: DAY,
        lineIds: [...days, flagged],
        actIds: preview.selection.act,
        expectedDigest: preview.selection.digest,
      },
    });
    expect(done.approved).toHaveLength(3);
    expect(done.notInPreview).toEqual([flagged]);
    for (const id of days) expect(await lineStatus(id)).toBe("approved");
    expect(await lineStatus(flagged)).toBe("pending");
  });

  it("refuses at the server a day the caller can't read", async () => {
    const stranger = await timesheetDay(await addWorker());
    await expect(
      previewBulkTimesheetSpec.run({
        supabase: staff.lineManager.client,
        organisationId: owner.orgId,
        userId: staff.lineManager.id,
        role: "line_manager",
        data: { period: DAY, lineIds: [stranger] },
      }),
    ).rejects.toBeInstanceOf(NotInList);
  });
});

describe("bulk resend and cancel worker invites", () => {
  interface InviteOut {
    sent?: { worker_id: string }[];
    cancelled?: { worker_id: string }[];
    skipped: { worker_id: string; code: string }[];
  }

  async function openInvites(workerId: string) {
    const { rows } = await db.query<{ id: string; sent_via: string }>(
      "select id, sent_via from public.worker_invites where worker_id = $1 and used_at is null and revoked_at is null",
      [workerId],
    );
    return rows;
  }

  async function printInvite(workerId: string) {
    const res = await staff.hr.client.rpc("create_worker_invites", {
      p_organisation_id: owner.orgId,
      p_worker_ids: [workerId],
      p_sent_via: "print",
    });
    expect(res.error).toBeNull();
  }

  function commit(workerId: string, client: Client = staff.hr.client) {
    return client.rpc("commit_worker_invite_resends", {
      p_organisation_id: owner.orgId,
      p_invites: [{ worker_id: workerId, invite_id: randomUUID(), token_hash: "ab".repeat(32) }],
    });
  }

  it("claims a resend only for workers whose invite can be resent, and lists the rest", async () => {
    const invited = await addWorker({ email: `inv-${randomUUID()}@example.test` });
    const noEmail = await addWorker();
    const never = await addWorker({ email: `never-${randomUUID()}@example.test` });
    const signedUp = await addWorker({ email: `up-${randomUUID()}@example.test` });
    await printInvite(invited);
    await printInvite(noEmail);
    await workerSession(signedUp);
    // A PIN set with an unused invite still counts as signed up (security review L2).
    const pinOnly = await addWorker({ email: `pin-${randomUUID()}@example.test` });
    await workerSession(pinOnly);
    await printInvite(pinOnly);
    const before = await openInvites(invited);
    const ids = [invited, noEmail, never, signedUp, pinOnly];

    const dry = await staff.hr.client.rpc("bulk_resend_worker_invites", {
      p_organisation_id: owner.orgId,
      p_worker_ids: ids,
      p_dry_run: true,
    });
    expect(dry.error).toBeNull();
    const preview = dry.data as unknown as InviteOut;
    expect(preview.sent!.map((s) => s.worker_id)).toEqual([invited]);
    const codes = Object.fromEntries(preview.skipped.map((s) => [s.worker_id, s.code]));
    expect(codes).toEqual({
      [noEmail]: "no_email",
      [never]: "not_invited",
      [signedUp]: "signed_up",
      [pinOnly]: "signed_up",
    });

    // Step 1 claims the email but changes no invite: the old link still works.
    const claim = await staff.hr.client.rpc("bulk_resend_worker_invites", {
      p_organisation_id: owner.orgId,
      p_worker_ids: [invited],
    });
    expect(claim.error).toBeNull();
    expect((claim.data as unknown as InviteOut).sent!.map((s) => s.worker_id)).toEqual([invited]);
    expect(await openInvites(invited)).toEqual(before);

    // Once a day per worker.
    const again = await staff.hr.client.rpc("bulk_resend_worker_invites", {
      p_organisation_id: owner.orgId,
      p_worker_ids: [invited],
      p_dry_run: true,
    });
    expect((again.data as unknown as InviteOut).skipped).toEqual([
      expect.objectContaining({ worker_id: invited, code: "resent_today" }),
    ]);

    // Step 2, after the email went out: the new invite replaces the old one.
    const resentBefore = await auditCount("worker_invite.resent");
    const batchBefore = await auditCount("worker_invites.bulk_resent");
    const committed = await commit(invited);
    expect(committed.error).toBeNull();
    expect((committed.data as { resent: unknown[] }).resent).toHaveLength(1);
    const after = await openInvites(invited);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).not.toBe(before[0]!.id);
    expect(after[0]!.sent_via).toBe("email");
    expect(await auditCount("worker_invite.resent")).toBe(resentBefore + 1);
    expect(await auditCount("worker_invites.bulk_resent")).toBe(batchBefore + 1);
  });

  it("records a resend only for a worker claimed today, so nobody else loses their link", async () => {
    const w = await addWorker({ email: `nc-${randomUUID()}@example.test` });
    await printInvite(w);
    const before = await openInvites(w);
    const res = await commit(w);
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({
      resent: [],
      skipped: [{ worker_id: w, code: "not_claimed" }],
    });
    expect(await openInvites(w)).toEqual(before);
  });

  it("skips and lists a worker past a cap, who keeps their open invite", async () => {
    const w = await addWorker({ email: `cap-${randomUUID()}@example.test` });
    await printInvite(w);
    const before = await openInvites(w);
    const res = await staff.hr.client.rpc("bulk_resend_worker_invites", {
      p_organisation_id: owner.orgId,
      p_worker_ids: [w],
      p_org_cap: 0,
    });
    expect(res.error).toBeNull();
    const out = res.data as unknown as InviteOut;
    expect(out.sent).toEqual([]);
    expect(out.skipped).toEqual([expect.objectContaining({ worker_id: w, code: "cap" })]);
    expect(await openInvites(w)).toEqual(before);
    // Caps can only be lowered, never raised past the shared ones.
    const raised = await staff.hr.client.rpc("bulk_resend_worker_invites", {
      p_organisation_id: owner.orgId,
      p_worker_ids: [w],
      p_org_cap: 1000,
    });
    expect(raised.error?.code).toBe("22023");
  });

  it("stops invite resends at their own sub-cap of 20 a company a day (security review M3)", async () => {
    const w = await addWorker({ email: `sub-${randomUUID()}@example.test` });
    await printInvite(w);
    const { rows: existing } = await db.query<{ n: number }>(
      `select count(*)::int as n from public.manager_emails
        where organisation_id = $1 and kind = 'worker_invite_resend'
          and created_at > now() - interval '24 hours'`,
      [owner.orgId],
    );
    const seeded: string[] = [];
    try {
      for (let i = existing[0]!.n; i < 20; i += 1) {
        const id = randomUUID();
        await db.query(
          `insert into public.manager_emails (organisation_id, kind, ref_id, recipients)
           values ($1, 'worker_invite_resend', $2, 1)`,
          [owner.orgId, id],
        );
        seeded.push(id);
      }
      const res = await staff.hr.client.rpc("bulk_resend_worker_invites", {
        p_organisation_id: owner.orgId,
        p_worker_ids: [w],
        p_dry_run: true,
      });
      expect(res.error).toBeNull();
      expect((res.data as unknown as InviteOut).skipped).toEqual([
        expect.objectContaining({ worker_id: w, code: "cap" }),
      ]);
    } finally {
      if (seeded.length > 0) {
        // Insert-only for everyone: lifted for this clean-up only, so other suites keep the pool.
        await db.query("begin");
        await db.query("set local session_replication_role = replica");
        await db.query(
          "delete from public.manager_emails where kind = 'worker_invite_resend' and ref_id = any($1::uuid[])",
          [seeded],
        );
        await db.query("commit");
      }
    }
  });

  it("cancels open invites and skips workers with none", async () => {
    const open = await addWorker();
    const none = await addWorker();
    await printInvite(open);
    const before = await auditCount("worker_invite.cancelled");
    const res = await staff.hr.client.rpc("bulk_cancel_worker_invites", {
      p_organisation_id: owner.orgId,
      p_worker_ids: [open, none],
    });
    expect(res.error).toBeNull();
    const out = res.data as unknown as InviteOut;
    expect(out.cancelled!.map((c) => c.worker_id)).toEqual([open]);
    expect(out.skipped).toEqual([
      expect.objectContaining({ worker_id: none, code: "no_open_invite" }),
    ]);
    expect(await openInvites(open)).toEqual([]);
    expect(await auditCount("worker_invite.cancelled")).toBe(before + 1);
    expect(await auditCount("worker_invites.bulk_cancelled")).toBeGreaterThan(0);
  });

  it("is for owner, admin and hr only, and refuses another company's workers", async () => {
    const w = await addWorker();
    await printInvite(w);
    for (const fn of ["bulk_resend_worker_invites", "bulk_cancel_worker_invites"] as const) {
      const ops = await staff.ops.client.rpc(fn, {
        p_organisation_id: owner.orgId,
        p_worker_ids: [w],
      });
      expect(ops.error?.code, fn).toBe(DENIED);
      const foreign = await addWorker({}, other.orgId);
      const mixed = await staff.hr.client.rpc(fn, {
        p_organisation_id: owner.orgId,
        p_worker_ids: [w, foreign],
      });
      expect(mixed.error?.code, fn).toBe("MLLB2");
      const notMine = await staff.hr.client.rpc(fn, {
        p_organisation_id: other.orgId,
        p_worker_ids: [foreign],
      });
      expect(notMine.error?.code, fn).toBe(DENIED);
    }
    expect((await commit(w, staff.ops.client)).error?.code).toBe(DENIED);
    expect(await openInvites(w)).toHaveLength(1);
  });
});

describe("untrusted sessions", () => {
  it("get 42501 from every bulk function, even with the owner's roles", async () => {
    const email = `rls-lb-untrusted-${randomUUID()}@example.test`;
    const password = `${randomUUID()}a1`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    const client = anonClient();
    expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
    const { error: memberError } = await admin
      .from("memberships")
      .insert({ organisation_id: owner.orgId, user_id: created.data.user!.id, role: "hr" });
    expect(memberError).toBeNull();
    await addMember(
      { id: created.data.user!.id, email, client } as TestUser,
      "ops_manager",
      other.orgId,
    );

    const w = await addWorker();
    const results = await Promise.all([
      client.rpc("bulk_approve_leave", { p_organisation_id: owner.orgId, p_request_ids: [w] }),
      client.rpc("bulk_resend_worker_invites", {
        p_organisation_id: owner.orgId,
        p_worker_ids: [w],
      }),
      client.rpc("bulk_cancel_worker_invites", {
        p_organisation_id: owner.orgId,
        p_worker_ids: [w],
      }),
      client.rpc("approve_clean_timesheet_lines", {
        p_organisation_id: other.orgId,
        p_line_ids: [randomUUID()],
      }),
      client.rpc("commit_worker_invite_resends", {
        p_organisation_id: owner.orgId,
        p_invites: [{ worker_id: w, invite_id: randomUUID(), token_hash: "ab".repeat(32) }],
      }),
    ]);
    for (const { error } of results) expect(error?.code).toBe(DENIED);
  });
});
