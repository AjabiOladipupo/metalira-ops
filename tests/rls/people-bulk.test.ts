/**
 * Slice U.1 People bulk actions, against the real database:
 * - public.bulk_end_employment ends everyone selected through end_employment, all or nothing:
 *   one person who can't be ended (already ended, a date before their start, another
 *   company's id) refuses the whole batch with a reason per person (MLBU2) and nothing changes.
 *   One audit row per person and one for the batch.
 * - Owner, admin and hr may (the single end_employment's roles); ops_manager and line managers
 *   are refused (42501), and so is a company the caller isn't in.
 * - The preview counts future shifts and leave after the last working day.
 * - bulk_set_line_manager and bulk_set_department follow the single mapping's rules.
 * - A line manager's filters and export never reach anyone but their reportees, and the export
 *   never carries personal data or pay.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EMPTY_FILTERS } from "@/lib/people-filters";
import {
  SELECTION_CHANGED,
  SelectionChanged,
  bulkDepartmentSpec,
  bulkEndEmploymentSpec,
  bulkLineManagerSpec,
  exportPeopleSpec,
  previewBulkEndSpec,
  previewBulkReassignSpec,
} from "@/server/people/bulk";
import { loadScopedPeople, selectPeople } from "@/server/people/people-scope";
import type { Database, Json } from "@/types/db";

import {
  adminClient,
  anonClient,
  createTenantUser,
  createTestUser,
  insertMembershipAsOwner,
  pgClient,
  type Client,
  type TenantUser,
  type TestUser,
} from "./helpers/supabase";

type Role = Database["public"]["Enums"]["membership_role"];

const DENIED = "42501";

function lagosDate(offsetDays = 0): string {
  const at = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(at);
}

const TODAY = lagosDate();
const IN_5 = lagosDate(5);
const IN_10 = lagosDate(10);
const SINCE = "2025-01-06";
const REASON = "Contract with the client ended";

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
let hr: TestUser;
let adminUser: TestUser;
let ops: TestUser;
let lineManager: TestUser;
let lineManagerMembership: string;
let departmentId: string;
let secondDepartmentId: string;
let siteA: string;
let leaveTypeId: string;
let staff = 0;

async function addMember(user: TestUser, role: Role): Promise<string> {
  const { data, error } = await admin
    .from("memberships")
    .insert({ organisation_id: owner.orgId, user_id: user.id, role })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

async function newWorker(fields: Record<string, Json> = {}, orgId?: string): Promise<string> {
  staff += 1;
  const id = randomUUID();
  const by = orgId && orgId !== owner.orgId ? other.client : hr.client;
  const { error } = await by.rpc("create_worker", {
    p_worker: {
      id,
      organisation_id: orgId ?? owner.orgId,
      staff_id: `BU-${String(staff).padStart(4, "0")}`,
      first_name: "Bola",
      last_name: `Bulk ${staff}`,
      employment_type: "permanent",
      start_date: SINCE,
      ...fields,
    },
  });
  expect(error).toBeNull();
  return id;
}

async function statusOf(id: string): Promise<{ status: string; end_date: string | null }> {
  const { rows } = await db.query<{ status: string; end_date: string | null }>(
    "select status::text, end_date::text from public.workers where id = $1",
    [id],
  );
  return rows[0]!;
}

function endBulk(by: Client, ids: string[], endDate = TODAY, reason = REASON, org?: string) {
  return by.rpc("bulk_end_employment", {
    p_organisation_id: org ?? owner.orgId,
    p_worker_ids: ids,
    p_end_date: endDate,
    p_reason: reason,
  });
}

function problems(details: string | null | undefined): { worker_id: string; reason: string }[] {
  return JSON.parse(details ?? "[]") as { worker_id: string; reason: string }[];
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("bu-owner", "Bulk People Org");
  other = await createTenantUser("bu-other", "Other Bulk Org");
  hr = await createTestUser("bu-hr");
  adminUser = await createTestUser("bu-admin");
  ops = await createTestUser("bu-ops");
  lineManager = await createTestUser("bu-lm", "Kola Adebayo");
  await addMember(hr, "hr");
  await insertMembershipAsOwner(owner.orgId, adminUser.id, "admin");
  await addMember(ops, "ops_manager");
  lineManagerMembership = await addMember(lineManager, "line_manager");

  const departments = await hr.client
    .from("departments")
    .insert([
      { organisation_id: owner.orgId, name: "Security services" },
      { organisation_id: owner.orgId, name: "Cleaning services" },
    ])
    .select("id, name");
  expect(departments.error).toBeNull();
  departmentId = departments.data!.find((d) => d.name === "Security services")!.id;
  secondDepartmentId = departments.data!.find((d) => d.name === "Cleaning services")!.id;

  const client = await hr.client
    .from("clients")
    .insert({ organisation_id: owner.orgId, name: "Coastline Logistics" })
    .select("id")
    .single();
  expect(client.error).toBeNull();
  const site = await hr.client
    .from("sites")
    .insert({ organisation_id: owner.orgId, client_id: client.data!.id, name: "Apapa Gate" })
    .select("id")
    .single();
  expect(site.error).toBeNull();
  siteA = site.data!.id;

  await db.query("begin");
  await db.query("set local session_replication_role = replica");
  const { rows } = await db.query<{ id: string }>(
    `insert into public.leave_types (organisation_id, code, name)
     values ($1, 'bulk_test', 'Bulk test leave') returning id`,
    [owner.orgId],
  );
  await db.query("commit");
  leaveTypeId = rows[0]!.id;
});

afterAll(async () => {
  await db?.end();
});

describe("bulk_end_employment", () => {
  it("ends everyone selected in one go, closes their mapping and audits each person and the batch", async () => {
    const ids = [await newWorker(), await newWorker(), await newWorker()];
    const assign = await hr.client.from("worker_assignments").insert({
      organisation_id: owner.orgId,
      worker_id: ids[0]!,
      site_id: siteA,
      effective_from: SINCE,
    });
    expect(assign.error).toBeNull();

    const { data, error } = await endBulk(hr.client, ids);
    expect(error).toBeNull();
    expect(data).toMatchObject({ ended: 3, end_date: TODAY });
    for (const id of ids) expect(await statusOf(id)).toEqual({ status: "ended", end_date: TODAY });

    const { rows: assignments } = await db.query<{ to: string | null }>(
      "select effective_to::text as to from public.worker_assignments where worker_id = $1",
      [ids[0]],
    );
    expect(assignments).toEqual([{ to: TODAY }]);

    const { rows: audit } = await db.query<{
      action: string;
      entity_id: string | null;
      reason: string | null;
      after: Record<string, unknown>;
    }>(
      `select action, entity_id, reason, after from public.audit_log
       where organisation_id = $1
         and action in ('people.employment_ended', 'people.bulk_employment_ended')
         and (entity_id = any($2::uuid[]) or (entity_id is null and after->'worker_ids' ?| $3::text[]))`,
      [owner.orgId, ids, ids],
    );
    const perPerson = audit.filter((a) => a.action === "people.employment_ended");
    expect(perPerson.map((a) => a.entity_id).sort()).toEqual([...ids].sort());
    for (const row of perPerson) expect(row.reason).toBe(REASON);
    const batch = audit.filter((a) => a.action === "people.bulk_employment_ended");
    expect(batch).toHaveLength(1);
    expect(batch[0]!.after).toMatchObject({ count: 3, end_date: TODAY });
    expect(batch[0]!.reason).toBe(REASON);
  });

  it("refuses the whole batch when anyone is already ended or would end before their start", async () => {
    const fine = await newWorker();
    const ended = await newWorker();
    const late = await newWorker({ start_date: IN_10 });
    expect((await endBulk(hr.client, [ended], TODAY)).error).toBeNull();

    const { error } = await endBulk(hr.client, [fine, ended, late], IN_5);
    expect(error?.code).toBe("MLBU2");
    const reasons = new Map(problems(error?.details).map((p) => [p.worker_id, p.reason]));
    expect(reasons.get(ended)).toMatch(/^Already ended on /);
    expect(reasons.get(late)).toMatch(/before their start date/);
    expect(reasons.has(fine)).toBe(false);
    expect(await statusOf(fine)).toEqual({ status: "active", end_date: null });
    expect(await statusOf(late)).toEqual({ status: "active", end_date: null });
  });

  it("refuses another company's worker ids, and a company the caller isn't in", async () => {
    const mine = await newWorker();
    const theirs = await newWorker({}, other.orgId);
    const { error } = await endBulk(hr.client, [mine, theirs]);
    expect(error?.code).toBe("MLBU2");
    expect(problems(error?.details)).toEqual([
      expect.objectContaining({ worker_id: theirs, reason: "Not found in this company." }),
    ]);
    expect(await statusOf(mine)).toEqual({ status: "active", end_date: null });
    expect(await statusOf(theirs)).toEqual({ status: "active", end_date: null });

    const across = await endBulk(hr.client, [theirs], TODAY, REASON, other.orgId);
    expect(across.error?.code).toBe(DENIED);
    expect(await statusOf(theirs)).toEqual({ status: "active", end_date: null });
  });

  it("lets owner, admin and hr end employment, as the single action does; ops and line managers can't", async () => {
    for (const user of [owner, adminUser]) {
      const id = await newWorker();
      const { error } = await endBulk(user.client, [id]);
      expect(error).toBeNull();
      expect((await statusOf(id)).status).toBe("ended");
    }
    const reportee = await newWorker({ line_manager_membership_id: lineManagerMembership });
    for (const user of [ops, lineManager]) {
      const { error } = await endBulk(user.client, [reportee]);
      expect(error?.code).toBe(DENIED);
      const preview = await user.client.rpc("bulk_end_employment_preview", {
        p_organisation_id: owner.orgId,
        p_worker_ids: [reportee],
        p_end_date: TODAY,
      });
      expect(preview.error?.code).toBe(DENIED);
    }
    expect(await statusOf(reportee)).toEqual({ status: "active", end_date: null });
  });

  it("needs a reason, a date and at most 200 people", async () => {
    const id = await newWorker();
    expect((await endBulk(hr.client, [id], TODAY, "  ")).error?.code).toBe("MLBU3");
    expect((await endBulk(hr.client, [id], TODAY, "<b>bad</b>")).error?.code).toBe("MLBU3");
    const tooMany = Array.from({ length: 201 }, () => randomUUID());
    expect((await endBulk(hr.client, tooMany)).error?.code).toBe("MLBU1");
    expect((await endBulk(hr.client, [])).error?.code).toBe("MLBU1");
    expect(await statusOf(id)).toEqual({ status: "active", end_date: null });
  });
});

describe("bulk_end_employment_preview", () => {
  it("counts the shifts left uncovered and the leave after the last working day", async () => {
    const id = await newWorker();
    await db.query("begin");
    try {
      await db.query("set local session_replication_role = replica");
      await db.query(
        `insert into public.shift_assignments
           (organisation_id, shift_id, site_id, shift_date, worker_id, starts_at, ends_at, status,
            removed_at)
         values
           ($1, gen_random_uuid(), $2, $3::date, $4, now() + interval '5 days', now() + interval '5 days 8 hours', 'assigned', null),
           ($1, gen_random_uuid(), $2, $5::date, $4, now() + interval '10 days', now() + interval '10 days 8 hours', 'assigned', null),
           ($1, gen_random_uuid(), $2, $5::date, $4, now() + interval '10 days', now() + interval '10 days 8 hours', 'removed', now()),
           ($1, gen_random_uuid(), $2, $6::date, $4, now(), now() + interval '8 hours', 'assigned', null)`,
        [owner.orgId, siteA, IN_5, id, IN_10, TODAY],
      );
      await db.query(
        `insert into public.leave_requests
           (organisation_id, worker_id, leave_type_id, leave_year, start_date, end_date, days, status)
         values
           ($1, $2, $3, 2026, $4::date, $4::date, 1, 'approved'),
           ($1, $2, $3, 2026, $5::date, $5::date, 1, 'pending_hr'),
           ($1, $2, $3, 2026, $5::date, $5::date, 1, 'declined')`,
        [owner.orgId, id, leaveTypeId, IN_5, IN_10],
      );
      await db.query("commit");
    } catch (e) {
      await db.query("rollback");
      throw e;
    }

    const { data, error } = await hr.client.rpc("bulk_end_employment_preview", {
      p_organisation_id: owner.orgId,
      p_worker_ids: [id],
      p_end_date: TODAY,
    });
    expect(error).toBeNull();
    const people = (data as { people: Record<string, unknown>[] }).people;
    expect(people).toEqual([
      expect.objectContaining({
        worker_id: id,
        future_shifts: 2,
        leave_approved: 1,
        leave_pending: 1,
        refusal: null,
      }),
    ]);
    // A preview changes nothing.
    expect(await statusOf(id)).toEqual({ status: "active", end_date: null });
  });
});

describe("bulk_set_line_manager and bulk_set_department", () => {
  it("sets one line manager for everyone selected and audits each change and the batch", async () => {
    const lead = await newWorker();
    const ids = [await newWorker(), await newWorker()];
    const { data, error } = await hr.client.rpc("bulk_set_line_manager", {
      p_organisation_id: owner.orgId,
      p_worker_ids: ids,
      p_line_manager_worker_id: lead,
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ selected: 2, changed: 2 });
    const { rows } = await db.query<{ lm: string }>(
      "select line_manager_worker_id::text as lm from public.workers where id = any($1::uuid[])",
      [ids],
    );
    expect(rows.map((r) => r.lm)).toEqual([lead, lead]);
    const { rows: audit } = await db.query<{ n: string }>(
      `select count(*)::text as n from public.audit_log
       where organisation_id = $1 and action = 'people.line_manager_changed'
         and entity_id = any($2::uuid[])`,
      [owner.orgId, ids],
    );
    expect(audit[0]!.n).toBe("2");
  });

  it("refuses the whole batch for a leaver or a loop, and changes nothing", async () => {
    const a = await newWorker();
    const b = await newWorker({ line_manager_worker_id: a });
    const c = await newWorker();
    const gone = await newWorker();
    expect((await endBulk(hr.client, [gone])).error).toBeNull();

    const leaver = await hr.client.rpc("bulk_set_line_manager", {
      p_organisation_id: owner.orgId,
      p_worker_ids: [c, gone],
      p_line_manager_membership_id: lineManagerMembership,
    });
    expect(leaver.error?.code).toBe("MLBU2");

    // a reports to b would close a loop (b already reports to a): refused, c unchanged too.
    const loop = await hr.client.rpc("bulk_set_line_manager", {
      p_organisation_id: owner.orgId,
      p_worker_ids: [a, c],
      p_line_manager_worker_id: b,
    });
    expect(loop.error?.code).toBe("MLBU2");
    expect(problems(loop.error?.details)).toEqual([
      expect.objectContaining({ worker_id: a, reason: expect.stringMatching(/loop/) }),
    ]);
    const { rows } = await db.query<{ id: string; lm: string | null }>(
      "select id::text, line_manager_worker_id::text as lm from public.workers where id = any($1::uuid[])",
      [[a, c]],
    );
    expect(rows.every((r) => r.lm === null)).toBe(true);
  });

  it("moves people into one department; refuses another company's department and line managers", async () => {
    const ids = [await newWorker({ department_id: departmentId }), await newWorker()];
    const moved = await hr.client.rpc("bulk_set_department", {
      p_organisation_id: owner.orgId,
      p_worker_ids: ids,
      p_department_id: secondDepartmentId,
    });
    expect(moved.error).toBeNull();
    expect(moved.data).toMatchObject({ selected: 2, changed: 2 });

    const { data: theirs } = await other.client
      .from("departments")
      .insert({ organisation_id: other.orgId, name: "Theirs" })
      .select("id")
      .single();
    const wrong = await hr.client.rpc("bulk_set_department", {
      p_organisation_id: owner.orgId,
      p_worker_ids: ids,
      p_department_id: theirs!.id,
    });
    expect(wrong.error?.code).toBe("MLBU5");

    const byLineManager = await lineManager.client.rpc("bulk_set_department", {
      p_organisation_id: owner.orgId,
      p_worker_ids: ids,
      p_department_id: departmentId,
    });
    expect(byLineManager.error?.code).toBe(DENIED);
  });
});

describe("line manager scope and the export", () => {
  it("filters and exports only a line manager's reportees, whatever the filter or ids", async () => {
    const reportee = await newWorker({
      line_manager_membership_id: lineManagerMembership,
      department_id: departmentId,
    });
    const outsider = await newWorker({ department_id: departmentId });

    // No direct read of workers at all.
    const direct = await lineManager.client
      .from("workers")
      .select("id")
      .eq("organisation_id", owner.orgId)
      .eq("department_id", departmentId);
    expect(direct.data ?? []).toEqual([]);

    const people = await loadScopedPeople(lineManager.client, owner.orgId, "line_manager", TODAY);
    const byDept = selectPeople(people, {
      kind: "filters",
      filters: { ...EMPTY_FILTERS, dept: departmentId },
    }).map((p) => p.id);
    expect(byDept).toContain(reportee);
    expect(byDept).not.toContain(outsider);

    const file = await exportPeopleSpec.run({
      supabase: lineManager.client,
      organisationId: owner.orgId,
      userId: lineManager.id,
      role: "line_manager",
      data: { selection: { kind: "ids", ids: [reportee, outsider] } },
    });
    expect(file.count).toBe(1);
    expect(file.csv).toContain("BU-");
    const outsiderStaff = await db.query<{ staff_id: string }>(
      "select staff_id from public.workers where id = $1",
      [outsider],
    );
    expect(file.csv).not.toContain(`${outsiderStaff.rows[0]!.staff_id},`);
  });

  it("never exports personal data or pay", async () => {
    const id = randomUUID();
    await db.query("begin");
    try {
      await db.query("set local session_replication_role = replica");
      await db.query(
        `insert into public.workers
           (id, organisation_id, staff_id, first_name, last_name, employment_type, start_date,
            bank_name, account_name, bank_account_enc, bank_account_last4, nin_enc, tin,
            pfa_name, rsa_pin_enc, rsa_pin_last4, next_of_kin_name, next_of_kin_phone, phone)
         values ($1, $2, 'PII-0001', 'Ngozi', 'Private', 'permanent', $3,
                 'Zenith Bank', 'Ngozi Private', 'ENC-BANK-CIPHER', '9876', 'ENC-NIN-CIPHER',
                 'TIN-55501', 'Stanbic Pension', 'ENC-RSA-CIPHER', '4321', 'Kin Person',
                 '08030000001', '08030000002')`,
        [id, owner.orgId, SINCE],
      );
      await db.query(
        `insert into public.pay_rates
           (organisation_id, worker_id, pay_type, basic_kobo, housing_kobo, transport_kobo,
            other_allowances_kobo, effective_from)
         values ($1, $2, 'monthly', 12345600, 7654300, 0, 0, $3)`,
        [owner.orgId, id, SINCE],
      );
      await db.query("commit");
    } catch (e) {
      await db.query("rollback");
      throw e;
    }

    const file = await exportPeopleSpec.run({
      supabase: hr.client,
      organisationId: owner.orgId,
      userId: hr.id,
      role: "hr",
      data: { selection: { kind: "ids", ids: [id] } },
    });
    expect(file.count).toBe(1);
    expect(file.csv).toContain("Ngozi Private,PII-0001");
    for (const secret of [
      "Zenith",
      "9876",
      "ENC-",
      "TIN-55501",
      "Stanbic",
      "4321",
      "Kin Person",
      "0803000000",
      "123456",
      "76543",
      "Monthly",
    ]) {
      expect(file.csv, secret).not.toContain(secret);
    }
  });
});

describe("a confirm acts only on the people its preview showed (security review M1)", () => {
  /** A fresh department, so "all matching" means exactly the people put in it here. */
  async function department(name: string): Promise<string> {
    const { data, error } = await hr.client
      .from("departments")
      .insert({ organisation_id: owner.orgId, name: `${name} ${randomUUID().slice(0, 8)}` })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id;
  }

  const ctx = () => ({
    supabase: hr.client,
    organisationId: owner.orgId,
    userId: hr.id,
    role: "hr" as const,
  });
  const byDepartment = (dept: string) => ({
    kind: "filters" as const,
    filters: { ...EMPTY_FILTERS, dept },
  });

  it("refuses to end employment when someone joined the filter after the preview", async () => {
    const dept = await department("Joined");
    const first = [
      await newWorker({ department_id: dept }),
      await newWorker({ department_id: dept }),
    ];
    const preview = await previewBulkEndSpec.run({
      ...ctx(),
      data: { selection: byDepartment(dept), endDate: TODAY },
    });
    expect(preview.selection.count).toBe(2);
    expect([...preview.selection.ids].sort()).toEqual([...first].sort());

    const latecomer = await newWorker({ department_id: dept });
    const confirm = bulkEndEmploymentSpec.run({
      ...ctx(),
      data: {
        selection: byDepartment(dept),
        endDate: TODAY,
        reason: REASON,
        expectedDigest: preview.selection.digest,
      },
    });
    await expect(confirm).rejects.toBeInstanceOf(SelectionChanged);
    await expect(confirm).rejects.toMatchObject({ refusal: "MLBU6", message: SELECTION_CHANGED });
    for (const id of [...first, latecomer]) {
      expect(await statusOf(id)).toEqual({ status: "active", end_date: null });
    }

    // Previewed again, the confirm goes through for everyone now matching.
    const again = await previewBulkEndSpec.run({
      ...ctx(),
      data: { selection: byDepartment(dept), endDate: TODAY },
    });
    const done = await bulkEndEmploymentSpec.run({
      ...ctx(),
      data: {
        selection: byDepartment(dept),
        endDate: TODAY,
        reason: REASON,
        expectedDigest: again.selection.digest,
      },
    });
    expect(done.ended).toBe(3);
  });

  it("refuses a line manager change when someone left the filter after the preview", async () => {
    const dept = await department("Left");
    const lead = await newWorker();
    const ids = [
      await newWorker({ department_id: dept }),
      await newWorker({ department_id: dept }),
    ];
    const preview = await previewBulkReassignSpec.run({
      ...ctx(),
      data: { change: "line_manager", selection: byDepartment(dept), lineManager: `w:${lead}` },
    });
    expect(preview.selection.count).toBe(2);

    const moved = await hr.client
      .from("workers")
      .update({ department_id: departmentId })
      .eq("id", ids[1]!);
    expect(moved.error).toBeNull();

    await expect(
      bulkLineManagerSpec.run({
        ...ctx(),
        data: {
          selection: byDepartment(dept),
          lineManager: `w:${lead}`,
          expectedDigest: preview.selection.digest,
        },
      }),
    ).rejects.toMatchObject({ refusal: "MLBU6" });
    const { rows } = await db.query<{ lm: string | null }>(
      "select line_manager_worker_id::text as lm from public.workers where id = any($1::uuid[])",
      [ids],
    );
    expect(rows.every((r) => r.lm === null)).toBe(true);
  });

  it("refuses a department change when the list grew, and a digest that isn't the preview's", async () => {
    const dept = await department("Grew");
    const target = await department("Target");
    await newWorker({ department_id: dept });
    const preview = await previewBulkReassignSpec.run({
      ...ctx(),
      data: { change: "department", selection: byDepartment(dept), departmentId: target },
    });
    await newWorker({ department_id: dept });
    await expect(
      bulkDepartmentSpec.run({
        ...ctx(),
        data: {
          selection: byDepartment(dept),
          departmentId: target,
          expectedDigest: preview.selection.digest,
        },
      }),
    ).rejects.toMatchObject({ refusal: "MLBU6" });

    // Ticked ids are checked too: the digest must be the one their own preview gave.
    const ticked = await newWorker({ department_id: dept });
    await expect(
      bulkDepartmentSpec.run({
        ...ctx(),
        data: {
          selection: { kind: "ids", ids: [ticked] },
          departmentId: target,
          expectedDigest: preview.selection.digest,
        },
      }),
    ).rejects.toMatchObject({ refusal: "MLBU6" });
    const { rows } = await db.query<{ n: string }>(
      "select count(*)::text as n from public.workers where department_id = $1",
      [target],
    );
    expect(rows[0]!.n).toBe("0");
  });
});

describe("untrusted sessions (security review L2)", () => {
  it("get 42501 from all four functions, even with the HR role", async () => {
    const email = `rls-bu-untrusted-${randomUUID()}@example.test`;
    const password = `${randomUUID()}a1`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    const client = anonClient();
    expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
    const { error: memberError } = await admin
      .from("memberships")
      .insert({ organisation_id: owner.orgId, user_id: created.data.user!.id, role: "hr" });
    expect(memberError).toBeNull();

    const id = await newWorker();
    const results = await Promise.all([
      client.rpc("bulk_end_employment_preview", {
        p_organisation_id: owner.orgId,
        p_worker_ids: [id],
        p_end_date: TODAY,
      }),
      endBulk(client, [id]),
      client.rpc("bulk_set_line_manager", {
        p_organisation_id: owner.orgId,
        p_worker_ids: [id],
        p_line_manager_membership_id: lineManagerMembership,
      }),
      client.rpc("bulk_set_department", {
        p_organisation_id: owner.orgId,
        p_worker_ids: [id],
        p_department_id: departmentId,
      }),
    ]);
    for (const { error } of results) expect(error?.code).toBe(DENIED);
    expect(await statusOf(id)).toEqual({ status: "active", end_date: null });
    const { rows } = await db.query<{ dept: string | null; lm: string | null }>(
      "select department_id::text as dept, line_manager_membership_id::text as lm from public.workers where id = $1",
      [id],
    );
    expect(rows[0]).toEqual({ dept: null, lm: null });
  });
});
