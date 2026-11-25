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
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays, lagosToday } from "@/lib/dates";
import type { Database } from "@/types/db";

import {
  addPayrollWorker,
  OCT_END,
  OCT_START,
  resultsFor,
  saveResults,
  SHA,
} from "./helpers/payroll";
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

  it("pre-fills from the last day's basic, the divisor, the owner's leave formula and the cap", async () => {
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
        leave: null,
        exempt_cap_kobo: "5000000000",
        exempt_used_kobo: "0",
      },
    ]);
    // An annual leave type of 15 days a year, with 3 days taken in 2026 (owner decision, 25 Nov):
    // 15 × 9 complete months (1 Jan to 5 Oct) ÷ 12 = 11.25, rounded down to 11, less 3 = 8 days.
    const type = await asDbOwner(
      `insert into public.leave_types (organisation_id, code, name) values ($1, 'annual', 'Annual')
       returning id`,
      [owner.orgId],
      true,
    );
    expect(type.error).toBeNull();
    const typeId = (type.result!.rows[0] as { id: string }).id;
    const entitlement = await asDbOwner(
      `insert into public.leave_entitlements
         (organisation_id, leave_type_id, effective_from, days_per_year)
       values ($1, $2, '2026-01-01', 15)`,
      [owner.orgId, typeId],
      true,
    );
    expect(entitlement.error).toBeNull();
    const taken = await asDbOwner(
      `insert into public.leave_ledger
         (organisation_id, worker_id, leave_type_id, leave_year, kind, days, request_id)
       values ($1, $2, $3, 2026, 'taken', -3, gen_random_uuid())`,
      [owner.orgId, workerId, typeId],
      true,
    );
    expect(taken.error).toBeNull();
    const after = await finance.client.rpc("payroll_final_pay_prefill", {
      p_organisation_id: owner.orgId,
      p_run_id: runId,
    });
    expect((after.data as { leave: unknown }[])[0]!.leave).toEqual({
      entitlement_days: 15,
      months_in_year: 9,
      taken_days: 3,
      service_months: 21,
      days: 8,
      year: 2026,
    });
  });

  it("pre-fills 0 leave days below 6 months' service (Labour Act s.18(4))", async () => {
    // A joiner on 1 Jun 2026 (the helper's pay rate starts in 2025, so the worker and the rate are
    // written here).
    const { data: joiner, error: joinerError } = await admin
      .from("workers")
      .insert({
        organisation_id: owner.orgId,
        staff_id: `PR-${randomUUID().slice(0, 8)}`,
        first_name: "Ada",
        last_name: "Obi",
        employment_type: "permanent",
        start_date: "2026-06-01",
        end_date: "2026-10-05",
        tax_state: "Lagos",
      })
      .select("id")
      .single();
    expect(joinerError).toBeNull();
    const newcomer = joiner!.id;
    const rate = await admin.from("pay_rates").insert({
      organisation_id: owner.orgId,
      worker_id: newcomer,
      pay_type: "monthly",
      basic_kobo: 6_000_000,
      housing_kobo: 3_600_000,
      transport_kobo: 2_400_000,
      other_allowances_kobo: 0,
      effective_from: "2026-06-01",
    });
    expect(rate.error).toBeNull();
    const run = await createRun([newcomer]);
    const { data } = await owner.client.rpc("payroll_final_pay_prefill", {
      p_organisation_id: owner.orgId,
      p_run_id: run,
    });
    expect((data as { leave: unknown }[])[0]!.leave).toEqual({
      entitlement_days: 15,
      months_in_year: 4,
      taken_days: 0,
      service_months: 4,
      days: 0,
      year: 2026,
    });
    // Paying it anyway (a contract may give it) needs the reason for the change.
    const paid = await owner.client.rpc("add_final_pay_item", {
      p_organisation_id: owner.orgId,
      p_run_id: run,
      p_worker_id: newcomer,
      p_item_type: "leave_in_lieu",
      p_days: 2,
      p_amount_kobo: "600000",
      p_computed_kobo: "600000",
      p_reason: "Contract gives leave from the first month",
    });
    expect(paid.error?.code).toBe("MLTB4");
  });

  it("adds leave in lieu on basic only, checked against days x basic ÷ 20", async () => {
    // 8 days x ₦60,000 ÷ 20 = ₦24,000.
    const stale = await add(hr.client, {
      p_item_type: "leave_in_lieu",
      p_days: 8,
      p_amount_kobo: "2400000",
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
      p_days: 8,
      p_amount_kobo: "2400000",
      p_computed_kobo: "2400000",
    });
    expect(ok.error).toBeNull();
    const { data: item } = await admin
      .from("payroll_final_pay_items")
      .select("item_type, days, prefill_days, basic_monthly_kobo, divisor_days, computed_kobo")
      .eq("id", ok.data!)
      .single();
    expect(item).toEqual({
      item_type: "leave_in_lieu",
      days: 8,
      prefill_days: 8,
      basic_monthly_kobo: 6_000_000,
      divisor_days: 20,
      computed_kobo: 2_400_000,
    });
    expect(await adjustments()).toEqual([
      {
        label: "Pay in lieu of untaken leave, 8 days",
        amount_kobo: 2_400_000,
        taxable: true,
        pensionable: false,
        final_pay_item_id: ok.data!,
      },
    ]);
    // One of each type a worker on a run.
    const again = await add(hr.client, {
      p_item_type: "leave_in_lieu",
      p_days: 8,
      p_amount_kobo: "2400000",
      p_computed_kobo: "2400000",
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

// ---------------------------------------------------------------------------
// 4. Review fixes
// ---------------------------------------------------------------------------

describe("no other path exempts pay (money and security review M1)", () => {
  it("refuses an earning not taxed through add_payroll_adjustment, on any run", async () => {
    const owner = await createTenantUser("leave-m1", "Exempt Bypass Org");
    const { workerId: leaver } = await addPayrollWorker(admin, owner.orgId, {
      end_date: "2026-10-05",
    });
    const { workerId: stayer } = await addPayrollWorker(admin, owner.orgId);
    const finalPay = await owner.client.rpc("create_off_cycle_run", {
      p_organisation_id: owner.orgId,
      p_period_start: OCT_START,
      p_pay_date: "2026-10-16",
      p_reason: "final_pay",
      p_note: "Made redundant",
      p_worker_ids: [leaver],
    });
    expect(finalPay.error).toBeNull();
    const regular = await owner.client.rpc("create_payroll_run", {
      p_organisation_id: owner.orgId,
      p_period_start: OCT_START,
    });
    expect(regular.error).toBeNull();
    for (const [runId, workerId] of [
      [finalPay.data!, leaver],
      [regular.data!, stayer],
    ] as const) {
      const exempt = await owner.client.rpc("add_payroll_adjustment", {
        p_organisation_id: owner.orgId,
        p_run_id: runId,
        p_worker_id: workerId,
        p_kind: "earning",
        p_label: "Redundancy pay",
        p_amount_kobo: "6000000000",
        p_pensionable: false,
        p_taxable: false,
        p_instalments: 1,
        p_reason: "Trying to skip the cap",
      });
      expect(exempt.error?.code).toBe("MLTB9");
      const taxed = await owner.client.rpc("add_payroll_adjustment", {
        p_organisation_id: owner.orgId,
        p_run_id: runId,
        p_worker_id: workerId,
        p_kind: "earning",
        p_label: "Bonus",
        p_amount_kobo: "100000",
        p_pensionable: false,
        p_taxable: true,
        p_instalments: 1,
        p_reason: "Long service",
      });
      expect(taxed.error).toBeNull();
    }
    // Not for the database owner either.
    const { error } = await asDbOwner(
      `insert into public.payroll_adjustments (organisation_id, run_id, worker_id, kind, label,
         amount_kobo, taxable, series_id, reason, created_by)
       values ($1, $2, $3, 'earning', 'Exempt', 100, false, gen_random_uuid(), 'x', $4)`,
      [owner.orgId, regular.data!, stayer, owner.id],
      true,
    );
    expect(error?.code).toBe("MLTB9");
  });
});

async function hasAdviserEngine(orgId: string, runId: string): Promise<boolean> {
  const { data: run } = await admin
    .from("payroll_runs")
    .select("rule_set_id")
    .eq("id", runId)
    .single();
  const { rows } = await db.query<{ has: boolean }>(
    "select private.tax_rule_set_has_adviser_engine($1, $2) as has",
    [orgId, run!.rule_set_id],
  );
  return rows[0]!.has;
}

describe("a final pay waits for the adviser's engine (MLTB8)", () => {
  it("refuses to submit a final-pay run holding items on a rule set without it", async () => {
    const owner = await createTenantUser("leave-engine", "Final Pay Engine Org");
    const leaver = await addPayrollWorker(admin, owner.orgId, { end_date: "2026-10-05" });
    const run = await owner.client.rpc("create_off_cycle_run", {
      p_organisation_id: owner.orgId,
      p_period_start: OCT_START,
      p_pay_date: "2026-10-16",
      p_reason: "final_pay",
      p_note: "Resigned",
      p_worker_ids: [leaver.workerId],
    });
    expect(run.error).toBeNull();
    const item = await owner.client.rpc("add_final_pay_item", {
      p_organisation_id: owner.orgId,
      p_run_id: run.data!,
      p_worker_id: leaver.workerId,
      p_item_type: "gratuity",
      p_amount_kobo: "5000000",
      p_reason: "Contract clause 12",
    });
    expect(item.error).toBeNull();
    const { data: adj } = await admin
      .from("payroll_adjustments")
      .select("id")
      .eq("final_pay_item_id", item.data!)
      .single();
    const doc = resultsFor(
      { workerId: leaver.workerId, payRateId: leaver.payRateId, adjustmentId: null },
      {
        anomalies: [],
        extra: [
          {
            code: "adjustment_earning",
            label: "Gratuity",
            amount: 5_000_000,
            sources: [{ kind: "adjustment", id: adj!.id, from: OCT_START, to: OCT_END }],
          },
        ],
      },
    );
    expect((await saveResults(admin, owner, run.data!, doc)).error).toBeNull();
    const engine = await hasAdviserEngine(owner.orgId, run.data!);
    const submitted = await owner.client.rpc("submit_payroll_run", {
      p_organisation_id: owner.orgId,
      p_run_id: run.data!,
    });
    if (engine) {
      // Slice 5.9a merged: the rule set carries year-to-date PAYE and NSITF on regular pay.
      expect(submitted.error).toBeNull();
    } else {
      expect(submitted.error?.code).toBe("MLTB8");
    }
  });
});

describe("the exemption room across runs (money review M4)", () => {
  it("gives a second final-pay run only the room left, and a discarded draft frees it", async () => {
    const owner = await createTenantUser("leave-room", "Exempt Room Org");
    const { workerId } = await addPayrollWorker(admin, owner.orgId, { end_date: "2026-10-05" });
    const create = async (periodStart: string, payDate: string) => {
      const { data, error } = await owner.client.rpc("create_off_cycle_run", {
        p_organisation_id: owner.orgId,
        p_period_start: periodStart,
        p_pay_date: payDate,
        p_reason: "final_pay",
        p_note: "Made redundant",
        p_worker_ids: [workerId],
      });
      expect(error).toBeNull();
      return data!;
    };
    const loss = (runId: string, amount: string, exempt: string) =>
      owner.client.rpc("add_final_pay_item", {
        p_organisation_id: owner.orgId,
        p_run_id: runId,
        p_worker_id: workerId,
        p_item_type: "loss_of_office",
        p_amount_kobo: amount,
        p_exempt_kobo: exempt,
        p_reason: "Redundancy settlement",
      });
    const first = await create(OCT_START, "2026-10-16");
    expect((await loss(first, "4000000000", "4000000000")).error).toBeNull();

    // The last day moves into November (corrected): a second final pay, there.
    const moved = await admin.from("workers").update({ end_date: "2026-11-05" }).eq("id", workerId);
    expect(moved.error).toBeNull();
    const second = await create("2026-10-20", "2026-11-16");
    // ₦40m already used: ₦10m of a ₦20m payment is exempt.
    expect((await loss(second, "2000000000", "2000000000")).error?.code).toBe("MLTB5");
    const ok = await loss(second, "2000000000", "1000000000");
    expect(ok.error).toBeNull();
    const { data: item } = await admin
      .from("payroll_final_pay_items")
      .select("exempt_kobo, exempt_used_kobo")
      .eq("id", ok.data!)
      .single();
    expect(item).toEqual({ exempt_kobo: 1_000_000_000, exempt_used_kobo: 4_000_000_000 });

    // Discarding the first draft frees its ₦40m: only the second run's ₦10m stays used.
    const discarded = await owner.client.rpc("discard_off_cycle_run", {
      p_organisation_id: owner.orgId,
      p_run_id: first,
      p_reason: "Wrong period",
    });
    expect(discarded.error).toBeNull();
    const { data: prefill } = await owner.client.rpc("payroll_final_pay_prefill", {
      p_organisation_id: owner.orgId,
      p_run_id: second,
    });
    expect((prefill as { exempt_used_kobo: string }[])[0]!.exempt_used_kobo).toBe("1000000000");
  });

  it("frees the room when an approved final pay is reversed", async () => {
    const owner = await createTenantUser("leave-rev", "Exempt Reversal Org");
    const finance = await createTestUser("leave-rev-fin");
    const finance2 = await createTestUser("leave-rev-fin2");
    await addMember(finance, "finance", owner.orgId);
    await addMember(finance2, "finance", owner.orgId);
    const leaver = await addPayrollWorker(admin, owner.orgId, { end_date: "2026-10-05" });
    const create = async (note: string) => {
      const { data, error } = await owner.client.rpc("create_off_cycle_run", {
        p_organisation_id: owner.orgId,
        p_period_start: OCT_START,
        p_pay_date: "2026-10-16",
        p_reason: "final_pay",
        p_note: note,
        p_worker_ids: [leaver.workerId],
      });
      expect(error).toBeNull();
      return data!;
    };
    const runId = await create("Made redundant");
    const item = await owner.client.rpc("add_final_pay_item", {
      p_organisation_id: owner.orgId,
      p_run_id: runId,
      p_worker_id: leaver.workerId,
      p_item_type: "loss_of_office",
      p_amount_kobo: "4000000000",
      p_exempt_kobo: "4000000000",
      p_reason: "Redundancy settlement",
    });
    expect(item.error).toBeNull();
    // A final pay with items is approved only on the adviser's engine (MLTB8). Until slice 5.9a
    // merges no rule set has it, so there is no approved final pay to reverse yet; this test runs
    // in full once it does.
    if (!(await hasAdviserEngine(owner.orgId, runId))) return;
    const { data: adj } = await admin
      .from("payroll_adjustments")
      .select("id")
      .eq("final_pay_item_id", item.data!)
      .single();
    const doc = resultsFor(
      { workerId: leaver.workerId, payRateId: leaver.payRateId, adjustmentId: null },
      {
        anomalies: [],
        extra: [
          {
            code: "adjustment_earning",
            label: "Redundancy or loss-of-office compensation, exempt part",
            amount: 4_000_000_000,
            sources: [{ kind: "adjustment", id: adj!.id, from: OCT_START, to: OCT_END }],
          },
        ],
        mutate: (d) => {
          const slip = (d.payslips as { lines: Record<string, unknown>[] }[])[0]!;
          slip.lines.find((l) => l.code === "adjustment_earning")!.taxable = false;
        },
      },
    );
    expect((await saveResults(admin, owner, runId, doc)).error).toBeNull();
    const submitted = await owner.client.rpc("submit_payroll_run", {
      p_organisation_id: owner.orgId,
      p_run_id: runId,
    });
    expect(submitted.error).toBeNull();
    const { data: clock } = await admin.rpc("payroll_clock");
    const checked = await admin.rpc("record_payroll_approval_check", {
      p_organisation_id: owner.orgId,
      p_run_id: runId,
      p_actor: finance.id,
      p_inputs_sha256: SHA,
      p_read_started_at: clock!,
    });
    expect(checked.error).toBeNull();
    const approved = await finance.client.rpc("approve_payroll_run", {
      p_organisation_id: owner.orgId,
      p_run_id: runId,
    });
    expect(approved.error).toBeNull();
    const reversal = await finance.client.rpc("reverse_payroll_run", {
      p_organisation_id: owner.orgId,
      p_run_id: runId,
      p_reason: "Settlement withdrawn",
    });
    expect(reversal.error).toBeNull();
    const reversed = await finance2.client.rpc("approve_payroll_reversal", {
      p_organisation_id: owner.orgId,
      p_run_id: reversal.data!,
    });
    expect(reversed.error).toBeNull();
    // A new final pay for the worker starts with the whole cap again.
    const again = await create("Redundancy, second settlement");
    const { data: prefill } = await owner.client.rpc("payroll_final_pay_prefill", {
      p_organisation_id: owner.orgId,
      p_run_id: again,
    });
    expect((prefill as { exempt_used_kobo: string }[])[0]!.exempt_used_kobo).toBe("0");
  });
});

describe("personal numbers in free text (security review L3)", () => {
  it("ignores every character but letters and digits, in SQL and TypeScript alike", async () => {
    const { hasPersonalNumber } = await import("@/lib/personal-number");
    for (const [text, expected] of [
      ["080.1234.5678", true],
      ["0801/234/5678", true],
      ["(0801) 234 5678", true],
      ["NIN: 123_456_789_01", true],
      ["P.E.N 1234-5678-9012", true],
      ["Resigned 05/10/2026", false],
      ["123.456.789", false],
      ["Award for 10 years, 2026", false],
    ] as const) {
      const { rows } = await db.query<{ has: boolean }>(
        "select private.has_personal_number($1) as has",
        [text],
      );
      expect(rows[0]!.has, text).toBe(expected);
      expect(hasPersonalNumber(text), text).toBe(expected);
    }
  });
});
