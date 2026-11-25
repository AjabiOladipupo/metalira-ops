/**
 * Slice 5.9c against the real database (docs/PHASE_5.md "As built in 5.9c"):
 * - The holiday pay multiplier: owner, hr and finance add dated versions from tomorrow or later
 *   (MLTB3 otherwise), audited; others are refused (42501); rows never change or go, for the
 *   database owner too.
 * - Every rule set version carries the loss-of-office cap, ₦50,000,000 by default, never changed
 *   (MLTB7).
 * - Final-pay items go only on a final-pay draft (MLTB1) for its workers (MLTB2); leave and notice
 *   pay are checked against days x basic ÷ divisor (MLTB5) and need a reason when they differ
 *   from the pre-fill (MLTB4); redundancy pay is split into an exempt and a taxable earning, the
 *   exempt part capped per worker across payments; nothing is pensionable; removing either row
 *   removes the item; items never change (MLTB6).
 */
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays, lagosToday } from "@/lib/dates";
import type { Database } from "@/types/db";

import { addPayrollWorker, OCT_START } from "./helpers/payroll";
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

const DENIED = "42501";

let admin: Client;
let db: pg.Client;

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
});

afterAll(async () => {
  await db?.end();
});

async function addMember(user: TestUser, role: Role, orgId: string) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

async function asDbOwner(sql: string, params: unknown[], replica = false) {
  await db.query("begin");
  try {
    if (replica) await db.query("set local session_replication_role = replica");
    const result = await db.query(sql, params);
    await db.query("commit");
    return { error: null as null | { code?: string; message: string }, result };
  } catch (error) {
    await db.query("rollback");
    return { error: error as { code?: string; message: string }, result: null };
  }
}

const later = (days: number) => addDays(lagosToday(), days);

// ---------------------------------------------------------------------------
// 1. The holiday pay multiplier
// ---------------------------------------------------------------------------

describe("the holiday pay multiplier", () => {
  let owner: TenantUser;
  let hr: TestUser;
  let finance: TestUser;
  let lm: TestUser;

  beforeAll(async () => {
    owner = await createTenantUser("leave-hol", "Holiday Pay Org");
    hr = await createTestUser("leave-hol-hr");
    finance = await createTestUser("leave-hol-fin");
    lm = await createTestUser("leave-hol-lm");
    await addMember(hr, "hr", owner.orgId);
    await addMember(finance, "finance", owner.orgId);
    await addMember(lm, "line_manager", owner.orgId);
  });

  const set = (client: Client, bps: number, from: string, reason = "New guard contracts") =>
    client.rpc("set_holiday_pay_multiplier", {
      p_organisation_id: owner.orgId,
      p_multiplier_bps: bps,
      p_effective_from: from,
      p_reason: reason,
    });

  it("lets owner, hr and finance add versions from tomorrow or later, audited", async () => {
    const a = await set(owner.client, 15_000, later(3));
    expect(a.error).toBeNull();
    expect(a.data).toMatchObject({ before_bps: 10_000, after_bps: 15_000 });
    const b = await set(hr.client, 20_000, later(5));
    expect(b.error).toBeNull();
    expect(b.data).toMatchObject({ before_bps: 15_000, after_bps: 20_000 });
    const c = await set(finance.client, 10_000, later(7));
    expect(c.error).toBeNull();

    const { data: rows } = await finance.client
      .from("payroll_holiday_pay_rates")
      .select("effective_from, multiplier_bps")
      .eq("organisation_id", owner.orgId)
      .order("effective_from");
    expect(rows).toEqual([
      { effective_from: later(3), multiplier_bps: 15_000 },
      { effective_from: later(5), multiplier_bps: 20_000 },
      { effective_from: later(7), multiplier_bps: 10_000 },
    ]);
    const { data: audit } = await admin
      .from("audit_log")
      .select("action")
      .eq("organisation_id", owner.orgId)
      .eq("action", "payroll.holiday_pay_rate_added");
    expect(audit).toHaveLength(3);
  });

  it("refuses today, the past, a taken day, a no-op and out-of-range multipliers", async () => {
    expect((await set(owner.client, 15_000, lagosToday())).error?.code).toBe("MLTB3");
    expect((await set(owner.client, 15_000, later(-10))).error?.code).toBe("MLTB3");
    expect((await set(owner.client, 25_000, later(3))).error?.code).toBe("MLTB3");
    // 2.0x is already in force from day 6 (the version of day 5).
    expect((await set(owner.client, 20_000, later(6))).error?.code).toBe("22023");
    expect((await set(owner.client, 9_999, later(9))).error?.code).toBe("22023");
    expect((await set(owner.client, 50_001, later(9))).error?.code).toBe("22023");
    expect((await set(owner.client, 15_000, later(9), "Call 08012345678")).error?.code).toBe(
      "22023",
    );
  });

  it("refuses other roles and other companies, and shows them nothing", async () => {
    expect((await set(lm.client, 15_000, later(11))).error?.code).toBe(DENIED);
    const other = await createTenantUser("leave-hol-other", "Holiday Pay Other Org");
    const theirs = await other.client.rpc("set_holiday_pay_multiplier", {
      p_organisation_id: owner.orgId,
      p_multiplier_bps: 15_000,
      p_effective_from: later(11),
      p_reason: "Attack",
    });
    expect(theirs.error?.code).toBe(DENIED);
    const { data } = await lm.client
      .from("payroll_holiday_pay_rates")
      .select("id")
      .eq("organisation_id", owner.orgId);
    expect(data).toEqual([]);
  });

  it("never changes or deletes a version, for the database owner too", async () => {
    const { rows } = await db.query<{ id: string }>(
      "select id from public.payroll_holiday_pay_rates where organisation_id = $1 limit 1",
      [owner.orgId],
    );
    const id = rows[0]!.id;
    for (const replica of [false, true]) {
      expect(
        (
          await asDbOwner(
            "update public.payroll_holiday_pay_rates set multiplier_bps = 30000 where id = $1",
            [id],
            replica,
          )
        ).error?.code,
      ).toBe("MLTB3");
      expect(
        (
          await asDbOwner(
            "delete from public.payroll_holiday_pay_rates where id = $1",
            [id],
            replica,
          )
        ).error?.code,
      ).toBe("MLTB3");
    }
    expect((await asDbOwner("truncate public.payroll_holiday_pay_rates", [])).error?.code).toBe(
      "MLPRD",
    );
    // A past-dated insert is refused even with the secret key or as the database owner.
    expect(
      (
        await asDbOwner(
          `insert into public.payroll_holiday_pay_rates
             (organisation_id, effective_from, multiplier_bps, reason, created_by)
           values ($1, $2, 15000, 'Backdated', $3)`,
          [owner.orgId, later(-1), owner.id],
          true,
        )
      ).error?.code,
    ).toBe("MLTB3");
  });
});

// ---------------------------------------------------------------------------
// 2. The loss-of-office cap on rule sets
// ---------------------------------------------------------------------------

describe("the loss-of-office cap on every rule set", () => {
  it("is ₦50,000,000 by default and never changes", async () => {
    const owner = await createTenantUser("leave-cap", "Loss Cap Org");
    const ensured = await owner.client.rpc("ensure_tax_rule_set", {
      p_organisation_id: owner.orgId,
    });
    expect(ensured.error).toBeNull();
    const { rows } = await db.query<{ id: string; cap: string }>(
      `select id, loss_of_office_exempt_kobo::text as cap from public.tax_rule_sets
       where organisation_id = $1`,
      [owner.orgId],
    );
    expect(rows.map((r) => r.cap)).toEqual(["5000000000"]);
    for (const replica of [false, true]) {
      const { error } = await asDbOwner(
        "update public.tax_rule_sets set loss_of_office_exempt_kobo = 1 where id = $1",
        [rows[0]!.id],
        replica,
      );
      expect(error?.code).toBe("MLTB7");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Final-pay items
// ---------------------------------------------------------------------------

describe("final-pay items", () => {
  let owner: TenantUser;
  let hr: TestUser;
  let finance: TestUser;
  let workerId: string;
  let stayerId: string;
  let runId: string;

  const createRun = async (ids: string[], reason: "final_pay" | "one_off" = "final_pay") => {
    const { data, error } = await owner.client.rpc("create_off_cycle_run", {
      p_organisation_id: owner.orgId,
      p_period_start: OCT_START,
      p_pay_date: "2026-10-16",
      p_reason: reason,
      p_note: "Made redundant, last day 5 October",
      p_worker_ids: ids,
    });
    expect(error).toBeNull();
    return data!;
  };

  const add = (
    client: Client,
    over: Partial<Database["public"]["Functions"]["add_final_pay_item"]["Args"]> = {},
  ) =>
    client.rpc("add_final_pay_item", {
      p_organisation_id: owner.orgId,
      p_run_id: runId,
      p_worker_id: workerId,
      p_item_type: "gratuity",
      p_amount_kobo: "5000000",
      p_reason: "Contract clause 12",
      ...over,
    });

  const adjustments = async (run = runId) => {
    const { data } = await admin
      .from("payroll_adjustments")
      .select("label, amount_kobo, taxable, pensionable, final_pay_item_id")
      .eq("run_id", run)
      .order("label");
    return data ?? [];
  };

  beforeAll(async () => {
    owner = await createTenantUser("leave-fp", "Final Pay Org");
    hr = await createTestUser("leave-fp-hr");
    finance = await createTestUser("leave-fp-fin");
    await addMember(hr, "hr", owner.orgId);
    await addMember(finance, "finance", owner.orgId);
    ({ workerId } = await addPayrollWorker(admin, owner.orgId, { end_date: "2026-10-05" }));
    ({ workerId: stayerId } = await addPayrollWorker(admin, owner.orgId));
    runId = await createRun([workerId]);
  });

  it("pre-fills from the last day's basic, the divisor, the leave balance and the cap", async () => {
    const before = await hr.client.rpc("payroll_final_pay_prefill", {
      p_organisation_id: owner.orgId,
      p_run_id: runId,
    });
    expect(before.error).toBeNull();
    expect(before.data).toEqual([
      {
        worker_id: workerId,
        start_date: "2025-01-06",
        end_date: "2026-10-05",
        basic_monthly_kobo: "6000000",
        divisor_days: 20,
        annual_balance_days: null,
        exempt_cap_kobo: "5000000000",
        exempt_used_kobo: "0",
      },
    ]);
    // An annual leave type with 6 days on the 2026 ledger.
    const type = await asDbOwner(
      `insert into public.leave_types (organisation_id, code, name) values ($1, 'annual', 'Annual')
       returning id`,
      [owner.orgId],
      true,
    );
    expect(type.error).toBeNull();
    const ledger = await asDbOwner(
      `insert into public.leave_ledger
         (organisation_id, worker_id, leave_type_id, leave_year, kind, days, reason, actor)
       values ($1, $2, $3, 2026, 'adjustment', 6, 'Seeded balance', $4)`,
      [owner.orgId, workerId, (type.result!.rows[0] as { id: string }).id, owner.id],
      true,
    );
    expect(ledger.error).toBeNull();
    const after = await finance.client.rpc("payroll_final_pay_prefill", {
      p_organisation_id: owner.orgId,
      p_run_id: runId,
    });
    expect((after.data as { annual_balance_days: number }[])[0]!.annual_balance_days).toBe(6);
  });

  it("adds leave in lieu on basic only, checked against days x basic ÷ 20", async () => {
    // 6 days x ₦60,000 ÷ 20 = ₦18,000.
    const stale = await add(hr.client, {
      p_item_type: "leave_in_lieu",
      p_days: 6,
      p_amount_kobo: "1800000",
      p_computed_kobo: "3600000",
    });
    expect(stale.error?.code).toBe("MLTB5");
    const changed = await add(hr.client, {
      p_item_type: "leave_in_lieu",
      p_days: 5,
      p_amount_kobo: "1500000",
      p_computed_kobo: "1500000",
    });
    expect(changed.error?.code).toBe("MLTB4");
    const ok = await add(hr.client, {
      p_item_type: "leave_in_lieu",
      p_days: 6,
      p_amount_kobo: "1800000",
      p_computed_kobo: "1800000",
    });
    expect(ok.error).toBeNull();
    const { data: item } = await admin
      .from("payroll_final_pay_items")
      .select("item_type, days, balance_days, basic_monthly_kobo, divisor_days, computed_kobo")
      .eq("id", ok.data!)
      .single();
    expect(item).toEqual({
      item_type: "leave_in_lieu",
      days: 6,
      balance_days: 6,
      basic_monthly_kobo: 6_000_000,
      divisor_days: 20,
      computed_kobo: 1_800_000,
    });
    expect(await adjustments()).toEqual([
      {
        label: "Pay in lieu of untaken leave, 6 days",
        amount_kobo: 1_800_000,
        taxable: true,
        pensionable: false,
        final_pay_item_id: ok.data!,
      },
    ]);
    // One of each type a worker on a run.
    const again = await add(hr.client, {
      p_item_type: "leave_in_lieu",
      p_days: 6,
      p_amount_kobo: "1800000",
      p_computed_kobo: "1800000",
    });
    expect(again.error?.code).toBe("23505");
  });

  it("splits redundancy pay at ₦50,000,000, and counts what the worker already used", async () => {
    // ₦40,000,000: all exempt.
    const wrong = await add(owner.client, {
      p_item_type: "loss_of_office",
      p_amount_kobo: "4000000000",
      p_exempt_kobo: "0",
    });
    expect(wrong.error?.code).toBe("MLTB5");
    const loss = await add(owner.client, {
      p_item_type: "loss_of_office",
      p_amount_kobo: "4000000000",
      p_exempt_kobo: "4000000000",
    });
    expect(loss.error).toBeNull();
    // Notice pay that is part of the settlement shares the cap: ₦10,000,000 of ₦20,000,000 left.
    const notice = await add(owner.client, {
      p_item_type: "notice_in_lieu",
      p_days: 20,
      p_amount_kobo: "2000000000",
      p_computed_kobo: "6000000",
      p_exempt_kobo: "1000000000",
      p_part_of_settlement: true,
      p_change_reason: "Settlement agreement, clause 4",
    });
    expect(notice.error).toBeNull();
    const rows = (await adjustments()).filter((a) => a.label.startsWith("Pay in lieu of notice"));
    expect(rows).toEqual([
      {
        label: "Pay in lieu of notice, 20 days, exempt part",
        amount_kobo: 1_000_000_000,
        taxable: false,
        pensionable: false,
        final_pay_item_id: notice.data!,
      },
      {
        label: "Pay in lieu of notice, 20 days, taxable part",
        amount_kobo: 1_000_000_000,
        taxable: true,
        pensionable: false,
        final_pay_item_id: notice.data!,
      },
    ]);
    const prefill = await owner.client.rpc("payroll_final_pay_prefill", {
      p_organisation_id: owner.orgId,
      p_run_id: runId,
    });
    expect((prefill.data as { exempt_used_kobo: string }[])[0]!.exempt_used_kobo).toBe(
      "5000000000",
    );
  });

  it("removes the whole item when either row is removed", async () => {
    const { data: item } = await admin
      .from("payroll_final_pay_items")
      .select("id")
      .eq("run_id", runId)
      .eq("item_type", "notice_in_lieu")
      .single();
    const { data: rows } = await admin
      .from("payroll_adjustments")
      .select("id")
      .eq("final_pay_item_id", item!.id);
    expect(rows).toHaveLength(2);
    const removed = await hr.client.rpc("remove_payroll_adjustment", {
      p_organisation_id: owner.orgId,
      p_adjustment_id: rows![0]!.id,
      p_reason: "Entered twice",
    });
    expect(removed.error).toBeNull();
    const { data: left } = await admin
      .from("payroll_adjustments")
      .select("id")
      .eq("final_pay_item_id", item!.id);
    expect(left).toEqual([]);
    const { data: gone } = await admin
      .from("payroll_final_pay_items")
      .select("id")
      .eq("id", item!.id);
    expect(gone).toEqual([]);
  });

  it("goes only on a final-pay draft, for its workers, by owner or hr", async () => {
    expect((await add(finance.client)).error?.code).toBe(DENIED);
    expect((await add(owner.client, { p_worker_id: stayerId })).error?.code).toBe("MLTB2");
    const oneOff = await createRun([stayerId], "one_off");
    expect((await add(owner.client, { p_run_id: oneOff, p_worker_id: stayerId })).error?.code).toBe(
      "MLTB1",
    );
    expect((await add(owner.client, { p_days: 3 })).error?.code).toBe("22023");
    expect((await add(owner.client, { p_reason: "Call 08012345678" })).error?.code).toBe("22023");
    const gratuity = await add(hr.client);
    expect(gratuity.error).toBeNull();
    const { data: adj } = await admin
      .from("payroll_adjustments")
      .select("taxable, pensionable")
      .eq("final_pay_item_id", gratuity.data!)
      .single();
    expect(adj).toEqual({ taxable: true, pensionable: false });
  });

  it("never changes an item, for the database owner too", async () => {
    const { rows } = await db.query<{ id: string }>(
      "select id from public.payroll_final_pay_items where run_id = $1 limit 1",
      [runId],
    );
    for (const replica of [false, true]) {
      expect(
        (
          await asDbOwner(
            "update public.payroll_final_pay_items set amount_kobo = 1 where id = $1",
            [rows[0]!.id],
            replica,
          )
        ).error?.code,
      ).toBe("MLTB6");
    }
    expect(
      (await asDbOwner("truncate public.payroll_final_pay_items cascade", [])).error?.code,
    ).toBe("MLPRD");
    // An item without its earning rows is refused at commit (notice pay was removed above).
    const { error } = await asDbOwner(
      `insert into public.payroll_final_pay_items
         (organisation_id, run_id, worker_id, item_type, days, amount_kobo, reason, created_by)
       values ($1, $2, $3, 'notice_in_lieu', 1, 100, 'No rows', $4)`,
      [owner.orgId, runId, workerId, owner.id],
    );
    expect(error?.code).toBe("MLTB5");
  });

  it("goes with its run when the draft is discarded", async () => {
    const discarded = await owner.client.rpc("discard_off_cycle_run", {
      p_organisation_id: owner.orgId,
      p_run_id: runId,
      p_reason: "Started again",
    });
    expect(discarded.error).toBeNull();
    const { data } = await admin.from("payroll_final_pay_items").select("id").eq("run_id", runId);
    expect(data).toEqual([]);
    // A new final pay starts with the whole cap again.
    const fresh = await createRun([workerId]);
    const prefill = await owner.client.rpc("payroll_final_pay_prefill", {
      p_organisation_id: owner.orgId,
      p_run_id: fresh,
    });
    expect((prefill.data as { exempt_used_kobo: string }[])[0]!.exempt_used_kobo).toBe("0");
  });
});
