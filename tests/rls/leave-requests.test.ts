/**
 * Slice 4.4: leave requests and balances (docs/PHASE_4.md 4.4).
 * - The worker asks as themselves; the count skips off-days and holidays and matches
 *   src/lib/leave/days.ts; overlap, a past start, a short balance and minimum service are refused.
 * - Step order: line manager, then HR. A line manager decides only their reportees' step 1, never
 *   their own leave or step 2; HR can't decide step 1 for a worker who has a line manager; with no
 *   line manager, an ops manager decides step 1.
 * - The balance drops only at HR's approval; HR's cancellation gives the days back.
 * - leave_ledger and leave_decisions are insert-only for every role, the database owner included.
 * - The year: a joiner's grant is prorated; a version added later counts from its own date.
 * - Reads: ops managers see dates and type but no reason; workers read only their own rows.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { countLeaveDays } from "@/lib/leave/days";
import { prorateEntitlement } from "@/lib/leave/entitlements";
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

const PIN_HASH = `s1$k1$${"A".repeat(22)}$${"B".repeat(43)}`;

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
const staff = {} as Record<"hr" | "ops" | "lineManager" | "otherLm", TestUser>;
let counter = 0;
let annual: string;
let sick: string;
let year: number;
let today: string;

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
      staff_id: `LQ-${String(counter).padStart(4, "0")}-${randomUUID().slice(0, 4)}`,
      first_name: "Ada",
      last_name: `Obi ${counter}`,
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
async function workerSession(workerId: string, orgId = owner.orgId, inviter?: TestUser) {
  const invite = await (inviter ?? staff.hr).client.rpc("create_worker_invites", {
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

/** The next Monday at least `weeks` weeks ahead, inside this year (or null). */
function mondayAhead(weeks: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (8 - dow) + 7 * weeks);
  return d.toISOString().slice(0, 10);
}

function plus(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function balance(client: Client, workerId: string, typeId: string) {
  const { data, error } = await client.rpc("leave_balances", {
    p_organisation_id: owner.orgId,
    p_year: year,
    p_worker_ids: [workerId],
  });
  expect(error).toBeNull();
  return data!.find((b) => b.worker_id === workerId && b.leave_type_id === typeId)!;
}

let me: string;
let meClient: Client;
let noLm: string;
let noLmClient: Client;
let lmOwnWorker: string;
let start: string;
let roomInYear = true;

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("lq-owner", "Leave Requests Org");
  other = await createTenantUser("lq-other", "Other Leave Org");
  staff.hr = await createTestUser("lq-hr");
  staff.ops = await createTestUser("lq-ops");
  staff.lineManager = await createTestUser("lq-lm");
  staff.otherLm = await createTestUser("lq-other-lm");
  await addMember(staff.hr, "hr");
  await addMember(staff.ops, "ops_manager");
  // The line manager has a worker record of their own; their reportees point at it.
  lmOwnWorker = await addWorker();
  await addMember(staff.lineManager, "line_manager", owner.orgId, lmOwnWorker);
  await addMember(staff.otherLm, "line_manager", other.orgId);

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
  year = Number(today.slice(0, 4));
  start = mondayAhead(1);
  roomInYear = plus(start, 30).slice(0, 4) === String(year);

  me = await addWorker({ line_manager_worker_id: lmOwnWorker });
  noLm = await addWorker();
  meClient = await workerSession(me);
  noLmClient = await workerSession(noLm);
});

afterAll(async () => {
  await db?.end();
});

describe("the working-day count", () => {
  it("matches src/lib/leave/days.ts, skipping weekends and holidays", async () => {
    const holiday = plus(start, 2); // the Wednesday
    const added = await staff.hr.client.rpc("add_public_holiday", {
      p_organisation_id: owner.orgId,
      p_date: holiday,
      p_name: "Test holiday",
    });
    expect(added.error).toBeNull();
    try {
      const { data, error } = await staff.hr.client.rpc("leave_day_count", {
        p_organisation_id: owner.orgId,
        p_worker_id: me,
        p_leave_type_id: annual,
        p_from: start,
        p_to: plus(start, 6),
      });
      expect(error).toBeNull();
      const ts = countLeaveDays(start, plus(start, 6), "working_days", {
        workDays: [1, 2, 3, 4, 5],
        lastRostered: null,
        holidays: new Set([holiday]),
        shifts: [],
      });
      expect(ts.days).toBe(4);
      expect(data![0]!.days).toBe(ts.days);
    } finally {
      await staff.hr.client.rpc("remove_public_holiday", {
        p_organisation_id: owner.orgId,
        p_holiday_id: added.data!,
      });
    }
  });
});

describe("asking, deciding and the balance", () => {
  let requestId: string;

  it("the worker asks for 3 days; the balance doesn't drop yet", async () => {
    if (!roomInYear) return;
    const before = await balance(staff.hr.client, me, annual);
    const { data, error } = await meClient.rpc("request_leave", {
      p_organisation_id: owner.orgId,
      p_leave_type_id: annual,
      p_start_date: start,
      p_end_date: plus(start, 2),
      p_reason: "Family visit",
    });
    expect(error).toBeNull();
    const result = data as { id: string; days: number };
    expect(result.days).toBe(3);
    requestId = result.id;
    const after = await balance(staff.hr.client, me, annual);
    expect(after.balance).toBe(before.balance);
    expect(after.pending).toBe(3);
    expect(after.available).toBe(before.balance - 3);
  });

  it("refuses an overlap, a past start and someone else's worker", async () => {
    if (!roomInYear) return;
    const overlap = await meClient.rpc("request_leave", {
      p_organisation_id: owner.orgId,
      p_leave_type_id: sick,
      p_start_date: plus(start, 1),
      p_end_date: plus(start, 1),
    });
    expect(overlap.error?.code).toBe("MLLQ1");
    const past = await meClient.rpc("request_leave", {
      p_organisation_id: owner.orgId,
      p_leave_type_id: sick,
      p_start_date: plus(today, -7),
      p_end_date: plus(today, -7),
    });
    expect(past.error?.code).toBe("MLLQ8");
    const manager = await staff.hr.client.rpc("request_leave", {
      p_organisation_id: owner.orgId,
      p_leave_type_id: sick,
      p_start_date: plus(start, 14),
      p_end_date: plus(start, 14),
    });
    expect(manager.error).not.toBeNull();
  });

  it("HR can't decide step 1 for a worker with a line manager, nor step 2 before it", async () => {
    if (!roomInYear) return;
    const step1 = await staff.hr.client.rpc("decide_leave_line_manager", {
      p_organisation_id: owner.orgId,
      p_request_id: requestId,
      p_decision: "approved",
    });
    expect(step1.error?.code).toBe("42501");
    const step2 = await staff.hr.client.rpc("decide_leave_hr", {
      p_organisation_id: owner.orgId,
      p_request_id: requestId,
      p_decision: "approved",
    });
    expect(step2.error?.code).toBe("MLLQ4");
  });

  it("the worker can't decide; another company's line manager can't either", async () => {
    if (!roomInYear) return;
    const own = await meClient.rpc("decide_leave_line_manager", {
      p_organisation_id: owner.orgId,
      p_request_id: requestId,
      p_decision: "approved",
    });
    expect(own.error?.code).toBe("MLLQ6");
    const foreign = await staff.otherLm.client.rpc("decide_leave_line_manager", {
      p_organisation_id: owner.orgId,
      p_request_id: requestId,
      p_decision: "approved",
    });
    expect(foreign.error).not.toBeNull();
  });

  it("the line manager approves step 1 but can't decide step 2", async () => {
    if (!roomInYear) return;
    const step1 = await staff.lineManager.client.rpc("decide_leave_line_manager", {
      p_organisation_id: owner.orgId,
      p_request_id: requestId,
      p_decision: "approved",
    });
    expect(step1.error).toBeNull();
    const step2 = await staff.lineManager.client.rpc("decide_leave_hr", {
      p_organisation_id: owner.orgId,
      p_request_id: requestId,
      p_decision: "approved",
    });
    expect(step2.error?.code).toBe("42501");
  });

  it("HR approves and the balance drops by 3; cancelling gives them back", async () => {
    if (!roomInYear) return;
    const before = await balance(staff.hr.client, me, annual);
    const dry = await staff.hr.client.rpc("decide_leave_hr", {
      p_organisation_id: owner.orgId,
      p_request_id: requestId,
      p_decision: "approved",
      p_dry_run: true,
    });
    expect(dry.error).toBeNull();
    expect((await balance(staff.hr.client, me, annual)).balance).toBe(before.balance);
    const step2 = await staff.hr.client.rpc("decide_leave_hr", {
      p_organisation_id: owner.orgId,
      p_request_id: requestId,
      p_decision: "approved",
    });
    expect(step2.error).toBeNull();
    const after = await balance(staff.hr.client, me, annual);
    expect(after.balance).toBe(before.balance - 3);
    expect(after.taken).toBe(3);
    // The worker reads their own balance too.
    expect((await balance(meClient, me, annual)).balance).toBe(after.balance);

    const workerCancel = await meClient.rpc("cancel_leave_request", {
      p_organisation_id: owner.orgId,
      p_request_id: requestId,
    });
    expect(workerCancel.error?.code).toBe("MLLQ4");
    const cancel = await staff.hr.client.rpc("cancel_leave_request", {
      p_organisation_id: owner.orgId,
      p_request_id: requestId,
      p_reason: "Plans changed",
    });
    expect(cancel.error).toBeNull();
    expect((await balance(staff.hr.client, me, annual)).balance).toBe(before.balance);
  });

  it("a line manager can't decide their own leave", async () => {
    if (!roomInYear) return;
    const { rows } = await db.query<{ id: string }>(
      `insert into public.leave_requests (organisation_id, worker_id, leave_type_id, leave_year,
         start_date, end_date, days)
       values ($1, $2, $3, $4, $5, $5, 1) returning id`,
      [owner.orgId, lmOwnWorker, sick, year, plus(start, 21)],
    );
    const decided = await staff.lineManager.client.rpc("decide_leave_line_manager", {
      p_organisation_id: owner.orgId,
      p_request_id: rows[0]!.id,
      p_decision: "approved",
    });
    expect(decided.error?.code).toBe("MLLQ6");
  });

  it("with no line manager, the ops manager decides step 1 and reads no reason otherwise", async () => {
    if (!roomInYear) return;
    const { data, error } = await noLmClient.rpc("request_leave", {
      p_organisation_id: owner.orgId,
      p_leave_type_id: annual,
      p_start_date: plus(start, 7),
      p_end_date: plus(start, 7),
      p_reason: "Wedding",
    });
    expect(error).toBeNull();
    const id = (data as { id: string }).id;
    const list = await staff.ops.client.rpc("leave_request_list", {
      p_organisation_id: owner.orgId,
    });
    expect(list.error).toBeNull();
    const mine = list.data!.find((r) => r.id === id)!;
    expect(mine.can_decide_step1).toBe(true);
    expect(mine.reason).toBe("Wedding");
    // A request the line manager decides: the ops manager sees dates and type, no reason.
    const others = list.data!.filter((r) => r.worker_id === me);
    for (const r of others) expect(r.reason).toBeNull();
    // The ops manager reads no rows of the table itself.
    const direct = await staff.ops.client.from("leave_requests").select("id");
    expect(direct.data).toEqual([]);
    const decided = await staff.ops.client.rpc("decide_leave_line_manager", {
      p_organisation_id: owner.orgId,
      p_request_id: id,
      p_decision: "declined",
      p_note: "Short of cover that week",
    });
    expect(decided.error).toBeNull();
  });

  it("refuses a request longer than the balance", async () => {
    if (!roomInYear) return;
    const paternity = (
      await admin
        .from("leave_types")
        .select("id")
        .eq("organisation_id", owner.orgId)
        .eq("code", "paternity")
        .single()
    ).data!.id;
    // Paternity is 5 working days; ask for two weeks.
    const { error } = await meClient.rpc("request_leave", {
      p_organisation_id: owner.orgId,
      p_leave_type_id: paternity,
      p_start_date: plus(start, 28),
      p_end_date: plus(start, 39),
    });
    expect(["MLLQ2", "MLLQ8"]).toContain(error?.code);
  });
});

describe("insert-only rows", () => {
  for (const table of ["leave_ledger", "leave_decisions", "manager_emails"]) {
    it(`${table} refuses update, delete and truncate, the database owner included`, async () => {
      for (const sql of [
        `update public.${table} set created_at = created_at`,
        `delete from public.${table}`,
        `truncate public.${table}`,
      ]) {
        await expect(db.query(sql), sql).rejects.toThrow();
      }
    });
  }

  it("a leave request is never deleted and moves only along the steps", async () => {
    await expect(db.query("delete from public.leave_requests")).rejects.toThrow();
    await expect(db.query("truncate public.leave_requests")).rejects.toThrow();
    // A request of its own, on every date: a fresh worker, one day in January of this year
    // (the guard checks moves, not dates), walked along the steps as the database owner to
    // cancelled. It never moves back, nor does any decided request move backwards.
    const worker = await addWorker();
    const { rows } = await db.query<{ id: string }>(
      `insert into public.leave_requests (organisation_id, worker_id, leave_type_id, leave_year,
         start_date, end_date, days)
       values ($1, $2, $3, $4, $5, $5, 1) returning id`,
      [owner.orgId, worker, sick, year, `${year}-01-06`],
    );
    const id = rows[0]!.id;
    await db.query("update public.leave_requests set status = 'pending_hr' where id = $1", [id]);
    await db.query("update public.leave_requests set status = 'approved' where id = $1", [id]);
    await expect(
      db.query("update public.leave_requests set status = 'pending_hr' where id = $1", [id]),
    ).rejects.toMatchObject({ code: "MLLQ4" });
    await db.query(
      "update public.leave_requests set status = 'cancelled', cancelled_at = now() where id = $1",
      [id],
    );
    for (const back of ["approved", "pending_hr", "pending_line_manager"]) {
      await expect(
        db.query(
          "update public.leave_requests set status = $2, cancelled_at = null where id = $1",
          [id, back],
        ),
        back,
      ).rejects.toMatchObject({ code: "MLLQ4" });
    }
    const { rows: after } = await db.query<{ status: string }>(
      "select status from public.leave_requests where id = $1",
      [id],
    );
    expect(after[0]!.status).toBe("cancelled");
  });

  it("the secret key can't change ledger rows", async () => {
    const { error } = await admin
      .from("leave_ledger")
      .update({ days: 99 })
      .eq("organisation_id", owner.orgId);
    expect(error).not.toBeNull();
  });
});

describe("the leave year", () => {
  it("prorates a joiner's grant from the version in force on 1 January", async () => {
    const joiner = await addWorker({ start_date: `${year}-07-01` });
    const b = await balance(staff.hr.client, joiner, annual);
    expect(b.granted).toBe(prorateEntitlement(15, `${year}-07-01`, year));
  });

  it("is idempotent and leaves the secret key's call in the open", async () => {
    const first = await admin.rpc("ensure_leave_year", {
      p_organisation_id: owner.orgId,
      p_year: year,
    });
    expect(first.error).toBeNull();
    const second = await admin.rpc("ensure_leave_year", {
      p_organisation_id: owner.orgId,
      p_year: year,
    });
    expect(second.data).toBe(0);
  });

  it("refuses roles other than owner, admin and hr", async () => {
    const { error } = await staff.ops.client.rpc("ensure_leave_year", {
      p_organisation_id: owner.orgId,
      p_year: year,
    });
    expect(error?.code).toBe("42501");
  });

  it("HR adjusts with a reason; never below 0", async () => {
    const before = await balance(staff.hr.client, noLm, annual);
    const added = await staff.hr.client.rpc("adjust_leave_balance", {
      p_organisation_id: owner.orgId,
      p_worker_id: noLm,
      p_leave_type_id: annual,
      p_year: year,
      p_days: 2,
      p_reason: "Long service",
    });
    expect(added.error).toBeNull();
    expect((await balance(staff.hr.client, noLm, annual)).balance).toBe(before.balance + 2);
    const tooMuch = await staff.hr.client.rpc("adjust_leave_balance", {
      p_organisation_id: owner.orgId,
      p_worker_id: noLm,
      p_leave_type_id: annual,
      p_year: year,
      p_days: -366,
      p_reason: "Wrong",
    });
    expect(tooMuch.error?.code).toBe("MLLQ2");
    const lm = await staff.lineManager.client.rpc("adjust_leave_balance", {
      p_organisation_id: owner.orgId,
      p_worker_id: me,
      p_leave_type_id: annual,
      p_year: year,
      p_days: 1,
      p_reason: "Nice",
    });
    expect(lm.error?.code).toBe("42501");
  });
});

describe("security review fixes (L1 to L4)", () => {
  async function ledgerRows(workerId: string, y: number, kind?: string): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from public.leave_ledger
        where worker_id = $1 and leave_year = $2 and ($3::text is null or kind = $3)`,
      [workerId, y, kind ?? null],
    );
    return rows[0]!.n;
  }

  it("L1: workers and line managers never ensure a past year through a balance read", async () => {
    const past = year - 1;
    const worker = await meClient.rpc("leave_balances", {
      p_organisation_id: owner.orgId,
      p_year: past,
    });
    expect(worker.error).toBeNull();
    const lm = await staff.lineManager.client.rpc("leave_balances", {
      p_organisation_id: owner.orgId,
      p_year: past,
    });
    expect(lm.error).toBeNull();
    expect(await ledgerRows(me, past)).toBe(0);
  });

  it("L1: the first run of a year writes a carry_over row for every type, 0 where nothing carries", async () => {
    const fresh = await addWorker();
    await balance(staff.hr.client, fresh, annual);
    const { rows } = await db.query<{ types: number }>(
      `select count(*)::int as types from public.leave_types
        where organisation_id = $1 and status = 'active'`,
      [owner.orgId],
    );
    expect(await ledgerRows(fresh, year, "carry_over")).toBe(rows[0]!.types);
    const { rows: days } = await db.query<{ total: number }>(
      `select coalesce(sum(days), 0)::int as total from public.leave_ledger
        where worker_id = $1 and leave_year = $2 and kind = 'carry_over'`,
      [fresh, year],
    );
    expect(days[0]!.total).toBe(0);
    // A second run adds nothing: the carry-over is decided once.
    await admin.rpc("ensure_leave_year", { p_organisation_id: owner.orgId, p_year: year });
    expect(await ledgerRows(fresh, year, "carry_over")).toBe(rows[0]!.types);
  });

  it("L2: HR's decision and cancellations take the worker's leave lock", async () => {
    const { rows } = await db.query<{ name: string; src: string }>(
      `select p.proname as name, p.prosrc as src from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private'
          and p.proname in ('decide_leave_hr', 'cancel_leave_request', 'request_leave', 'adjust_leave_balance')`,
    );
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.src, row.name).toContain("'leave_requests:' ||");
  });

  it("L3: pay terms live in leave_request_pay, read by owner, admin and hr only", async () => {
    const { rows: columns } = await db.query(
      `select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'leave_requests'
          and column_name in ('pay_percent', 'pay_below_service')`,
    );
    expect(columns).toEqual([]);
    const lm = await staff.lineManager.client.from("leave_request_pay").select("request_id");
    expect(lm.error).toBeNull();
    expect(lm.data).toEqual([]);
    const worker = await meClient.from("leave_request_pay").select("request_id");
    expect(worker.data).toEqual([]);
    if (roomInYear) {
      // HR's approval earlier wrote one row for the approved request.
      const hr = await staff.hr.client.from("leave_request_pay").select("request_id, pay_percent");
      expect(hr.error).toBeNull();
      expect(hr.data!.length).toBeGreaterThan(0);
      expect(hr.data![0]!.pay_percent).toBe(100);
    }
    await expect(db.query("update public.leave_request_pay set pay_percent = 0")).rejects.toThrow();
    await expect(db.query("delete from public.leave_request_pay")).rejects.toThrow();
  });

  it("L4: only the service role skips the role check when ensuring a year", async () => {
    const worker = await meClient.rpc("ensure_leave_year", {
      p_organisation_id: owner.orgId,
      p_year: year,
    });
    expect(worker.error?.code).toBe("42501");
    const anon = await anonClient().rpc("ensure_leave_year", {
      p_organisation_id: owner.orgId,
      p_year: year,
    });
    expect(anon.error).not.toBeNull();
    const hr = await staff.hr.client.rpc("ensure_leave_year", {
      p_organisation_id: owner.orgId,
      p_year: year,
    });
    expect(hr.error).toBeNull();
  });
});

describe("reads", () => {
  it("a worker reads only their own requests and ledger", async () => {
    const reqs = await noLmClient.from("leave_requests").select("worker_id");
    expect(reqs.error).toBeNull();
    for (const r of reqs.data!) expect(r.worker_id).toBe(noLm);
    const ledger = await noLmClient.from("leave_ledger").select("worker_id");
    for (const r of ledger.data!) expect(r.worker_id).toBe(noLm);
  });

  it("a line manager reads their reportees' requests only", async () => {
    const { data } = await staff.lineManager.client.from("leave_requests").select("worker_id");
    for (const r of data ?? []) expect([me, lmOwnWorker]).toContain(r.worker_id);
    expect((data ?? []).some((r) => r.worker_id === noLm)).toBe(false);
  });

  it("another company's line manager sees nothing", async () => {
    const list = await staff.otherLm.client.rpc("leave_request_list", {
      p_organisation_id: other.orgId,
    });
    expect(list.error).toBeNull();
    expect(list.data).toEqual([]);
    const cross = await staff.otherLm.client.rpc("leave_request_list", {
      p_organisation_id: owner.orgId,
    });
    expect(cross.error?.code).toBe("42501");
  });

  it("only the server claims manager emails", async () => {
    const { error } = await staff.hr.client.rpc("claim_manager_email", {
      p_organisation_id: owner.orgId,
      p_kind: "leave_hr",
      p_ref_id: randomUUID(),
      p_recipients: 1,
      p_org_cap: 30,
      p_global_cap: 80,
    });
    expect(error).not.toBeNull();
  });
});

describe("timesheets skip approved leave (slice 4.2's hook)", () => {
  it("private.timesheet_on_leave is a real check", async () => {
    const { rows } = await db.query<{ src: string }>(
      "select prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'timesheet_on_leave'",
    );
    expect(rows[0]!.src).toContain("public.leave_requests");
  });
});
