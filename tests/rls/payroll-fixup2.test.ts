/**
 * Slice 5.10 (Phase 5 round-2 fix-up, migration 20261122280000) against the real database.
 * - Declared rent (security M1): only an owner or hr change workers.annual_rent_declared_kobo
 *   (MLFZ2); each change is a payroll.rent_declared_set audit row admins don't see.
 * - private.payroll_run_touchers (security L1) names, for the run's workers in its tax year, the
 *   opening-balance recorder, relief declarer, proof uploader, relief verifier and the last
 *   setter of the declared rent; approval refuses each of them (MLPRE). Release, reversal
 *   approval and supplementary confirmation read the same function.
 * - Approval compares the months each payslip's year_to_date step counted (money M2).
 * - Regular allowances (money L4): payroll_adjustments.regular only on an earning over 2 or more
 *   instalments.
 * - Personal numbers (security L3): people_bulk_reason and official_holidays refuse them.
 * - Final pay paid once (money M1): leave in lieu on another standing run comes off the pre-fill,
 *   and a second item of the same type needs p_further_reason (MLFZ1).
 */
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/types/db";

import { addPayrollWorker, OCT_START, resultsFor, saveResults, SHA } from "./helpers/payroll";
import { download, giveBankDetails, makeBatch, release } from "./helpers/payout";
import { approveRun, periodEnd, releaseRun, submitRunFor } from "./helpers/payslips";
import { verifyRelief } from "./helpers/reliefs";
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

let admin: Client;
let db: pg.Client;

interface Company {
  owner: TenantUser;
  hr: TestUser;
  hr2: TestUser;
  hr3: TestUser;
  hr4: TestUser;
  finance: TestUser;
  adminUser: TestUser;
}

async function company(label: string): Promise<Company> {
  const owner = await createTenantUser(`pfz-${label}-owner`, `Fixup2 ${label} Org`);
  const add = async (suffix: string, role: Role) => {
    const user = await createTestUser(`pfz-${label}-${suffix}`);
    const { error } = await admin
      .from("memberships")
      .insert({ organisation_id: owner.orgId, user_id: user.id, role });
    expect(error).toBeNull();
    return user;
  };
  return {
    owner,
    hr: await add("hr", "hr"),
    hr2: await add("hr2", "hr"),
    hr3: await add("hr3", "hr"),
    hr4: await add("hr4", "hr"),
    finance: await add("fin", "finance"),
    adminUser: await add("admin", "admin"),
  };
}

async function asDbOwner(sql: string, params: unknown[], replica = false) {
  await db.query("begin");
  try {
    if (replica) await db.query("set local session_replication_role = replica");
    const result = await db.query(sql, params);
    await db.query("commit");
    return { error: null as null | { code?: string }, result };
  } catch (error) {
    await db.query("rollback");
    return { error: error as { code?: string }, result: null };
  }
}

async function recordCheck(orgId: string, runId: string, actor: TestUser) {
  const clock = await admin.rpc("payroll_clock");
  expect(clock.error).toBeNull();
  const { error } = await admin.rpc("record_payroll_approval_check", {
    p_organisation_id: orgId,
    p_run_id: runId,
    p_actor: actor.id,
    p_inputs_sha256: SHA,
    p_read_started_at: clock.data!,
  });
  expect(error).toBeNull();
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
});

afterAll(async () => {
  await db?.end();
});

describe("declared rent: owner and hr only, audited (security review round 2, M1)", () => {
  let c: Company;
  let workerId: string;

  beforeAll(async () => {
    c = await company("rent");
    ({ workerId } = await addPayrollWorker(admin, c.owner.orgId));
  });

  it("refuses an admin's change to the rent, but not their other edits", async () => {
    const refused = await c.adminUser.client
      .from("workers")
      .update({ annual_rent_declared_kobo: 60_000_000 })
      .eq("id", workerId);
    expect(refused.error?.code).toBe("MLFZ2");
    const other = await c.adminUser.client
      .from("workers")
      .update({ job_title: "Senior guard" })
      .eq("id", workerId);
    expect(other.error).toBeNull();
  });

  it("lets hr change it, as a payroll.rent_declared_set audit row admins can't read", async () => {
    const { error } = await c.hr.client
      .from("workers")
      .update({ annual_rent_declared_kobo: 60_000_000 })
      .eq("id", workerId);
    expect(error).toBeNull();
    const { data } = await admin
      .from("audit_log")
      .select("actor_id, entity, after")
      .eq("organisation_id", c.owner.orgId)
      .eq("action", "payroll.rent_declared_set")
      .eq("entity_id", workerId);
    expect(data).toEqual([
      { actor_id: c.hr.id, entity: "workers", after: { rent_declared_kobo: "60000000" } },
    ]);
    const hidden = await c.adminUser.client
      .from("audit_log")
      .select("id")
      .eq("action", "payroll.rent_declared_set");
    expect(hidden.data).toEqual([]);
    // The setter is stamped on the row from the session (security review round 2, M-1).
    const { data: row } = await admin
      .from("workers")
      .select("rent_declared_by")
      .eq("id", workerId)
      .single();
    expect(row).toEqual({ rent_declared_by: c.hr.id });
  });

  it("keeps the setter stamp out of anyone's hands", async () => {
    const forged = await c.owner.client
      .from("workers")
      .update({ rent_declared_by: c.finance.id, job_title: "Supervisor" })
      .eq("id", workerId);
    expect(forged.error).toBeNull();
    const { data: row } = await admin
      .from("workers")
      .select("rent_declared_by")
      .eq("id", workerId)
      .single();
    expect(row).toEqual({ rent_declared_by: c.hr.id });
  });

  it("refuses payroll.rent_declared_set through public.log_audit, for every manager", async () => {
    for (const user of [c.owner, c.hr, c.adminUser]) {
      const { error } = await user.client.rpc("log_audit", {
        p_organisation_id: c.owner.orgId,
        p_action: "payroll.rent_declared_set",
        p_entity: "workers",
        p_entity_id: workerId,
      });
      expect(error?.code).toBe("42501");
    }
  });

  it("never saves a worker an admin inserts with a declared rent", async () => {
    const { error } = await c.adminUser.client.from("workers").insert({
      organisation_id: c.owner.orgId,
      staff_id: "PFZ-RENT-1",
      first_name: "Ada",
      last_name: "Obi",
      employment_type: "permanent",
      start_date: "2026-01-05",
      annual_rent_declared_kobo: 10_000_000,
    });
    expect(error?.code).toBe("MLFZ2");
    // Through create_worker (a definer acting for the signed-in admin) too.
    const viaRpc = await c.adminUser.client.rpc("create_worker", {
      p_worker: {
        id: "00000000-0000-4000-8000-00000000f210",
        organisation_id: c.owner.orgId,
        staff_id: "PFZ-RENT-2",
        first_name: "Ada",
        last_name: "Obi",
        employment_type: "permanent",
        start_date: "2026-01-05",
        annual_rent_declared_kobo: 10_000_000,
      },
    });
    expect(viaRpc.error?.code).toBe("MLFZ2");
    const { data } = await admin
      .from("workers")
      .select("id")
      .eq("organisation_id", c.owner.orgId)
      .in("staff_id", ["PFZ-RENT-1", "PFZ-RENT-2"]);
    expect(data).toEqual([]);
  });
});

describe("everyone who touched a run (security review round 2, L1)", () => {
  let c: Company;
  let worker: { workerId: string; payRateId: string };
  let runId: string;

  beforeAll(async () => {
    c = await company("touch");
    worker = await addPayrollWorker(admin, c.owner.orgId);
    // hr prepares and submits the October run.
    runId = await submitRunFor(admin, { ...c.hr, orgId: c.owner.orgId }, worker, OCT_START);
    // The worker's tax records for 2026, each by someone else.
    const opened = await c.hr2.client.rpc("record_payroll_opening_balance", {
      p_organisation_id: c.owner.orgId,
      p_worker_id: worker.workerId,
      p_tax_year: 2026,
      p_as_of_month: "2026-08-01",
      p_gross_kobo: "96000000",
      p_chargeable_kobo: "88320000",
      p_paye_kobo: "5248000",
      p_pension_kobo: "7680000",
      p_reason: "Go-live balances from the old payroll",
    });
    expect(opened.error).toBeNull();
    await verifyRelief(
      admin,
      { client: c.hr3.client, userId: c.hr3.id },
      { client: c.owner.client, userId: c.owner.id },
      c.owner.orgId,
      worker.workerId,
      "nhis",
      1_000_000n,
    );
    const rent = await c.hr4.client
      .from("workers")
      .update({ annual_rent_declared_kobo: 36_000_000 })
      .eq("id", worker.workerId);
    expect(rent.error).toBeNull();
  });

  it("names the opening recorder, relief declarer and proof uploader, verifier and rent setter", async () => {
    const { rows } = await db.query<{ t: string[] }>(
      "select private.payroll_run_touchers($1, $2) as t",
      [c.owner.orgId, runId],
    );
    const touchers = rows[0]!.t;
    expect(touchers).toEqual(
      expect.arrayContaining([c.hr.id, c.hr2.id, c.hr3.id, c.owner.id, c.hr4.id]),
    );
    expect(touchers).not.toContain(c.finance.id);
  });

  it("refuses the relief verifier's approval, and a different person approves", async () => {
    await recordCheck(c.owner.orgId, runId, c.owner);
    const refused = await c.owner.client.rpc("approve_payroll_run", {
      p_organisation_id: c.owner.orgId,
      p_run_id: runId,
    });
    expect(refused.error?.code).toBe("MLPRE");
    await approveRun(admin, c.owner.orgId, runId, c.finance);
  });

  it("refuses the relief verifier's release too (the same list)", async () => {
    await giveBankDetails(admin, c.owner.orgId, worker.workerId);
    const made = await makeBatch(admin, c.finance.client, c.owner.orgId, runId);
    expect(made.error).toBeNull();
    expect((await download(c.finance.client, c.owner.orgId, made.batchId)).error).toBeNull();
    const refused = await release(c.owner.client, c.owner.orgId, runId, made.batchId);
    expect(refused.error?.code).toBe("MLBF8");
  });

  it("ignores a hand-written rent audit row: the setter comes from the worker's row", async () => {
    const forged = await asDbOwner(
      `insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, after)
       values ($1, $2, 'payroll.rent_declared_set', 'workers', $3, '{}')`,
      [c.owner.orgId, c.finance.id, worker.workerId],
    );
    expect(forged.error).toBeNull();
    const { rows } = await db.query<{ t: string[] }>(
      "select private.payroll_run_touchers($1, $2) as t",
      [c.owner.orgId, runId],
    );
    expect(rows[0]!.t).not.toContain(c.finance.id);
    expect(rows[0]!.t).toContain(c.hr4.id);
  });

  it("counts only the run's tax year", async () => {
    // A 2025 opening balance for the worker doesn't make its recorder touch a 2026 run.
    const { rows } = await db.query<{ t: string[] }>(
      `select private.payroll_run_touchers($1, $2) as t`,
      [c.owner.orgId, runId],
    );
    const before = rows[0]!.t.length;
    const old = await asDbOwner(
      `insert into public.payroll_opening_balances
         (organisation_id, worker_id, tax_year, as_of_month, ytd_gross_kobo, ytd_chargeable_kobo,
          ytd_paye_kobo, ytd_pension_kobo, reason, created_by)
       values ($1, $2, 2025, '2025-06-01', 0, 0, 0, 0, 'Last year', $3)`,
      [c.owner.orgId, worker.workerId, c.finance.id],
    );
    expect(old.error).toBeNull();
    const after = await db.query<{ t: string[] }>(
      "select private.payroll_run_touchers($1, $2) as t",
      [c.owner.orgId, runId],
    );
    expect(after.rows[0]!.t).not.toContain(c.finance.id);
    expect(after.rows[0]!.t.length).toBe(before);
  });
});

describe("approval checks the months each payslip counted (money review round 2, M2)", () => {
  let c: Company;
  let worker: { workerId: string; payRateId: string };

  async function submitted(months: number): Promise<string> {
    const created = await c.owner.client.rpc("create_payroll_run", {
      p_organisation_id: c.owner.orgId,
      p_period_start: OCT_START,
    });
    expect(created.error).toBeNull();
    const doc = resultsFor(
      { ...worker, adjustmentId: null },
      {
        anomalies: [],
        mutate: (d) => {
          const slip = (d.payslips as Record<string, unknown>[])[0]!;
          slip.trace = {
            trace_version: 1,
            steps: [
              {
                step: "year_to_date",
                label: `Tax year so far: ${months} months`,
                formula: "No earlier payslips",
                inputs: { months, payslips: 0, opening_balance_id: "", relief_ids: "" },
                value_kobo: "0",
                rule_ref: "ytd",
              },
            ],
          };
        },
      },
    );
    expect((await saveResults(admin, c.owner, created.data!, doc)).error).toBeNull();
    const sub = await c.owner.client.rpc("submit_payroll_run", {
      p_organisation_id: c.owner.orgId,
      p_run_id: created.data!,
    });
    expect(sub.error).toBeNull();
    return created.data!;
  }

  beforeAll(async () => {
    c = await company("months");
    worker = await addPayrollWorker(admin, c.owner.orgId);
  });

  it("refuses a payslip that spread the year over months before the worker's first payslip", async () => {
    // The worker started in 2025, has no opening balance and no payslip in Metalira before
    // October: one month counts, not ten.
    const run = await submitted(10);
    await recordCheck(c.owner.orgId, run, c.finance);
    const refused = await c.finance.client.rpc("approve_payroll_run", {
      p_organisation_id: c.owner.orgId,
      p_run_id: run,
    });
    expect(refused.error?.code).toBe("MLPRF");
    const back = await c.finance.client.rpc("return_payroll_run", {
      p_organisation_id: c.owner.orgId,
      p_run_id: run,
      p_reason: "Months counted wrongly",
    });
    expect(back.error).toBeNull();
  });

  it("approves the month it should count", async () => {
    const { data: drafts } = await admin
      .from("payroll_runs")
      .select("id")
      .eq("organisation_id", c.owner.orgId)
      .eq("status", "draft");
    const run = drafts![0]!.id;
    const doc = resultsFor(
      { ...worker, adjustmentId: null },
      {
        anomalies: [],
        mutate: (d) => {
          const slip = (d.payslips as Record<string, unknown>[])[0]!;
          slip.trace = {
            trace_version: 1,
            steps: [
              {
                step: "year_to_date",
                label: "Tax year so far: 1 month from October 2026",
                formula: "No earlier payslips",
                inputs: { months: 1, payslips: 0, opening_balance_id: "", relief_ids: "" },
                value_kobo: "0",
                rule_ref: "ytd",
              },
            ],
          };
        },
      },
    );
    expect((await saveResults(admin, c.owner, run, doc)).error).toBeNull();
    const sub = await c.owner.client.rpc("submit_payroll_run", {
      p_organisation_id: c.owner.orgId,
      p_run_id: run,
    });
    expect(sub.error).toBeNull();
    await approveRun(admin, c.owner.orgId, run, c.finance);
  });

  it("counts from the worker's own first payslip, not the company's go-live", async () => {
    // October is now posted for the first worker; a second worker first paid in November counts
    // one month, while the first worker's November counts two.
    const later = await addPayrollWorker(admin, c.owner.orgId);
    const { rows } = await db.query<{ first: number; later: number }>(
      `select private.payroll_ytd_months($1, $2, '2026-11-25', gen_random_uuid()) as first,
              private.payroll_ytd_months($1, $3, '2026-11-25', gen_random_uuid()) as later`,
      [c.owner.orgId, worker.workerId, later.workerId],
    );
    expect(rows[0]).toEqual({ first: 2, later: 1 });
    const ctx = await c.finance.client.rpc("payroll_tax_context", {
      p_organisation_id: c.owner.orgId,
      p_pay_date: "2026-11-25",
      p_worker_ids: [worker.workerId, later.workerId],
    });
    expect(ctx.error).toBeNull();
    const firsts = Object.fromEntries(
      (
        ctx.data as { workers: { worker_id: string; first_pay_month: string | null }[] }
      ).workers.map((w) => [w.worker_id, w.first_pay_month]),
    );
    expect(firsts).toEqual({ [worker.workerId]: "2026-10-01", [later.workerId]: null });
  });
});

describe("regular allowances (money review round 2, L4)", () => {
  it("are earnings over 2 or more instalments only, marked by HR", async () => {
    const c = await company("regular");
    const { workerId } = await addPayrollWorker(admin, c.owner.orgId);
    const created = await c.owner.client.rpc("create_payroll_run", {
      p_organisation_id: c.owner.orgId,
      p_period_start: OCT_START,
    });
    expect(created.error).toBeNull();
    const add = (
      over: Partial<Database["public"]["Functions"]["add_payroll_adjustment"]["Args"]>,
    ) =>
      c.hr.client.rpc("add_payroll_adjustment", {
        p_organisation_id: c.owner.orgId,
        p_run_id: created.data!,
        p_worker_id: workerId,
        p_kind: "earning",
        p_label: "Site allowance",
        p_amount_kobo: "1500000",
        p_pensionable: false,
        p_taxable: true,
        p_instalments: 6,
        p_reason: "Lekki site, six months",
        ...over,
      });
    expect((await add({ p_regular: true, p_instalments: 1 })).error?.code).toBe("22023");
    expect((await add({ p_regular: true, p_kind: "deduction" })).error?.code).toBe("22023");
    const ok = await add({ p_regular: true });
    expect(ok.error).toBeNull();
    const bonus = await add({ p_label: "Bonus in three parts", p_instalments: 3 });
    expect(bonus.error).toBeNull();
    const { data } = await admin
      .from("payroll_adjustments")
      .select("id, regular")
      .in("id", [ok.data!, bonus.data!]);
    expect(Object.fromEntries((data ?? []).map((r) => [r.id, r.regular]))).toEqual({
      [ok.data!]: true,
      [bonus.data!]: false,
    });
  });
});

describe("personal numbers in free text (security review round 2, L3)", () => {
  it("refuses one in a bulk end-of-employment reason", async () => {
    const { error } = await asDbOwner("select private.people_bulk_reason($1)", [
      "Resigned; final pay to 0123456789",
    ]);
    expect(error?.code).toBe("MLBU3");
    const ok = await asDbOwner("select private.people_bulk_reason($1) as r", ["Resigned"]);
    expect(ok.error).toBeNull();
  });

  it("refuses one in an official holiday's name, source or reason", async () => {
    const base = {
      entry: "holiday",
      holiday_date: "2031-05-10",
      scope: "federal",
      recorded_by: "admin:00000000-0000-4000-8000-000000000001",
    };
    for (const over of [
      { name: "Holiday 0123456789", source: "Gazette" },
      { name: "Holiday", source: "Gazette 01.23.45.67.89" },
    ]) {
      const { error } = await admin.from("official_holidays").insert({ ...base, ...over });
      expect(error?.code).toBe("23514");
    }
  });
});

describe("final pay paid once (money review round 2, M1)", () => {
  it("takes leave in lieu on another standing run off the pre-fill, and asks why for a second item", async () => {
    const owner = await createTenantUser("pfz-final", "Fixup2 Final Pay Org");
    const { workerId } = await addPayrollWorker(admin, owner.orgId, { end_date: "2026-10-05" });
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
    const create = async (periodStart: string, payDate: string) => {
      const { data, error } = await owner.client.rpc("create_off_cycle_run", {
        p_organisation_id: owner.orgId,
        p_period_start: periodStart,
        p_pay_date: payDate,
        p_reason: "final_pay",
        p_note: "Resigned",
        p_worker_ids: [workerId],
      });
      expect(error).toBeNull();
      return data!;
    };
    const leave = (run: string, days: number, amount: string, further?: string) =>
      owner.client.rpc("add_final_pay_item", {
        p_organisation_id: owner.orgId,
        p_run_id: run,
        p_worker_id: workerId,
        p_item_type: "leave_in_lieu",
        p_days: days,
        p_amount_kobo: amount,
        p_computed_kobo: amount,
        p_reason: "Untaken leave on leaving",
        ...(further ? { p_further_reason: further } : {}),
      });
    // 15 days × 9 complete months ÷ 12 = 11 days; 11 × ₦60,000 ÷ 20 = ₦33,000.
    const first = await create(OCT_START, "2026-10-16");
    expect((await leave(first, 11, "3300000")).error).toBeNull();

    // The last day moves into November: a second final pay. 15 × 10 ÷ 12 = 12, less the 11 days
    // on the first run = 1 day.
    const moved = await admin.from("workers").update({ end_date: "2026-11-05" }).eq("id", workerId);
    expect(moved.error).toBeNull();
    const second = await create("2026-10-20", "2026-11-16");
    const { data: prefill } = await owner.client.rpc("payroll_final_pay_prefill", {
      p_organisation_id: owner.orgId,
      p_run_id: second,
    });
    const row = (
      prefill as { leave: Record<string, number>; other_run_item_types: string[] }[]
    )[0]!;
    expect(row.leave).toMatchObject({ months_in_year: 10, paid_elsewhere_days: 11, days: 1 });
    expect(row.other_run_item_types).toEqual(["leave_in_lieu"]);

    expect((await leave(second, 1, "300000")).error?.code).toBe("MLFZ1");
    const further = await leave(second, 1, "300000", "One more month worked after the date moved");
    expect(further.error).toBeNull();
    const { data: item } = await admin
      .from("payroll_final_pay_items")
      .select("prefill_days, further_reason")
      .eq("id", further.data!)
      .single();
    expect(item).toEqual({
      prefill_days: 1,
      further_reason: "One more month worked after the date moved",
    });

    // Discarding the first draft frees its days and its type.
    const discarded = await owner.client.rpc("discard_off_cycle_run", {
      p_organisation_id: owner.orgId,
      p_run_id: first,
      p_reason: "Wrong period",
    });
    expect(discarded.error).toBeNull();
    const { data: after } = await owner.client.rpc("payroll_final_pay_prefill", {
      p_organisation_id: owner.orgId,
      p_run_id: second,
    });
    const freed = (
      after as { leave: Record<string, number>; other_run_item_types: string[] }[]
    )[0]!;
    expect(freed.leave).toMatchObject({ paid_elsewhere_days: 0, days: 12 });
    expect(freed.other_run_item_types).toEqual([]);
  });
});

describe("clawbacks of one payslip across runs, and the window at approval (money review round 2)", () => {
  let c: Company;
  let worker: { workerId: string; payRateId: string };

  const NOV_START = "2026-10-20";
  const DEC_START = "2026-11-20";

  /** A draft regular run for the period, with a correction of `payslipId` added. */
  async function runWithCorrection(periodStart: string, payslipId: string, repeat = false) {
    const run = await c.owner.client.rpc("create_payroll_run", {
      p_organisation_id: c.owner.orgId,
      p_period_start: periodStart,
    });
    expect(run.error).toBeNull();
    const adj = await c.owner.client.rpc("add_payroll_correction", {
      p_organisation_id: c.owner.orgId,
      p_run_id: run.data!,
      p_payslip_id: payslipId,
      p_kind: "deduction",
      p_label: "Overpaid allowance",
      p_amount_kobo: "8000000",
      p_pensionable: false,
      p_reason: "Paid twice",
      ...(repeat ? { p_repeat: true } : {}),
    });
    expect(adj.error).toBeNull();
    return { runId: run.data!, adjustmentId: adj.data! };
  }

  /** Saves the run with one clawback line of `amount` kobo paying the correction. */
  function saveWithClawback(
    periodStart: string,
    runId: string,
    adjustmentId: string,
    amount: number,
  ) {
    const period = { start: periodStart, end: periodEnd(periodStart) };
    return saveResults(
      admin,
      c.owner,
      runId,
      resultsFor(
        { ...worker, adjustmentId: null },
        {
          anomalies: [],
          period,
          extra: [
            {
              code: "clawback",
              label: "Overpaid allowance, recovered before tax",
              amount: -amount,
              sources: [
                { kind: "adjustment", id: adjustmentId, from: period.start, to: period.end },
              ],
            },
          ],
        },
      ),
    );
  }

  beforeAll(async () => {
    c = await company("claw");
    worker = await addPayrollWorker(admin, c.owner.orgId);
  });

  it("refuses a second run's clawback past what the payslip's taxable pay has left (L3)", async () => {
    // October pays ₦120,000 taxable and is released.
    const oct = await submitRunFor(admin, c.owner, worker, OCT_START);
    await approveRun(admin, c.owner.orgId, oct, c.finance);
    await releaseRun(admin, c.owner, oct, c.finance);
    const { data: slip } = await admin.from("payslips").select("id").eq("run_id", oct).single();

    // November claws back ₦80,000 of it and is approved.
    const nov = await runWithCorrection(NOV_START, slip!.id);
    expect(
      (await saveWithClawback(NOV_START, nov.runId, nov.adjustmentId, 8_000_000)).error,
    ).toBeNull();
    expect(
      (
        await c.owner.client.rpc("submit_payroll_run", {
          p_organisation_id: c.owner.orgId,
          p_run_id: nov.runId,
        })
      ).error,
    ).toBeNull();
    await approveRun(admin, c.owner.orgId, nov.runId, c.finance);

    // December corrects the same payslip again: only ₦40,000 is left before tax.
    const dec = await runWithCorrection(DEC_START, slip!.id, true);
    const over = await saveWithClawback(DEC_START, dec.runId, dec.adjustmentId, 8_000_000);
    expect(over.error?.code).toBe("MLPR6");
    const fits = await saveWithClawback(DEC_START, dec.runId, dec.adjustmentId, 4_000_000);
    expect(fits.error).toBeNull();
  });

  it("refuses at approval a correction of an overpayment now older than the window (L5)", async () => {
    // June is released; a correction of it can't be added through add_payroll_correction
    // (MLYA1), so it is written as if it had been added while recent.
    const d = await company("aged");
    const w = await addPayrollWorker(admin, d.owner.orgId);
    const june = await submitRunFor(admin, d.owner, w, "2026-05-20");
    await approveRun(admin, d.owner.orgId, june, d.finance);
    await releaseRun(admin, d.owner, june, d.finance);
    const { data: slip } = await admin.from("payslips").select("id").eq("run_id", june).single();
    const run = await d.owner.client.rpc("create_payroll_run", {
      p_organisation_id: d.owner.orgId,
      p_period_start: OCT_START,
    });
    expect(run.error).toBeNull();
    const adjustmentId = "00000000-0000-4000-8000-00000000a6ed";
    const inserted = await asDbOwner(
      `insert into public.payroll_adjustments
         (id, organisation_id, run_id, worker_id, kind, label, amount_kobo, pensionable, taxable,
          series_id, instalment_number, instalment_count, reason, created_by, corrects_payslip_id)
       values ($1, $2, $3, $4, 'deduction', 'Overpaid allowance', 100, false, false, $1, 1, 1,
         'Paid twice', $5, $6)`,
      [adjustmentId, d.owner.orgId, run.data!, w.workerId, d.owner.id, slip!.id],
    );
    expect(inserted.error).toBeNull();
    const saved = await saveResults(
      admin,
      d.owner,
      run.data!,
      resultsFor(
        { ...w, adjustmentId: null },
        {
          anomalies: [],
          extra: [
            {
              code: "clawback",
              label: "Overpaid allowance, recovered before tax",
              amount: -100,
              sources: [
                { kind: "adjustment", id: adjustmentId, from: OCT_START, to: periodEnd(OCT_START) },
              ],
            },
          ],
        },
      ),
    );
    expect(saved.error).toBeNull();
    expect(
      (
        await d.owner.client.rpc("submit_payroll_run", {
          p_organisation_id: d.owner.orgId,
          p_run_id: run.data!,
        })
      ).error,
    ).toBeNull();
    await recordCheck(d.owner.orgId, run.data!, d.finance);
    const refused = await d.finance.client.rpc("approve_payroll_run", {
      p_organisation_id: d.owner.orgId,
      p_run_id: run.data!,
    });
    expect(refused.error?.code).toBe("MLYA1");
  });
});
