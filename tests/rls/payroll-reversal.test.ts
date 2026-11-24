/**
 * Slice 5.7a: payroll reversal and corrections (docs/PHASE_5.md 5.7) against the real database.
 * - reverse_payroll_run: owner or finance; approved runs only, never released (MLRV1); a reason;
 *   a downloaded bank file needs the statement it wasn't uploaded (MLRV5); one waiting reversal
 *   per run (MLRV3). The reversal copies every payslip and line with sign -1, summing to minus the
 *   original, and waits for a second person; the original can't be released meanwhile (MLRV9).
 * - approve_payroll_reversal: never the requester (MLRV4); in one transaction the original is
 *   reversed, its bank file and remittances voided (a recorded payment stays), its sources freed
 *   and the period reopened (timesheet_period_posted false, 4.3's reopen no longer MLTA5); the
 *   period runs again and pays the same sources. 5.3's approve_payroll_run can't approve a
 *   reversal. A declined reversal is never submitted again.
 * - Guards (ENABLE ALWAYS, replica mode included): a run is reversed only through an approved
 *   reversal, sources are freed only on a reversed run, remittance voids only for a reversed run,
 *   and a reversed run and its reversal never change.
 * - Corrections: add_payroll_correction names a released payslip of the same worker (MLRV8).
 * - RSA PIN snapshot: the payslip keeps the worker's encrypted PIN as saved with the results.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/types/db";

import { addPayrollWorker, resultsFor, saveResults } from "./helpers/payroll";
import {
  approveRun,
  download,
  enc,
  makeBatch,
  release,
  releaseThroughBankFile,
  seedSubmittedRun,
  type SeededPayrollRun,
} from "./helpers/payout";
import { seedReceipt } from "./helpers/statutory";
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
const MONEY = [
  "gross_kobo",
  "paye_kobo",
  "pension_employee_kobo",
  "pension_employer_kobo",
  "nhf_kobo",
  "other_deductions_kobo",
  "net_kobo",
  "nsitf_kobo",
  "itf_kobo",
  "employer_cost_kobo",
  "carried_forward_kobo",
] as const;

let admin: Client;
let db: pg.Client;

async function addMember(user: TestUser, role: Role, orgId: string) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

interface Company {
  owner: TenantUser;
  hr: TestUser;
  finance: TestUser;
  finance2: TestUser;
  lineManager: TestUser;
}

async function company(label: string): Promise<Company> {
  const owner = await createTenantUser(`prev-${label}-owner`, `Reversal ${label} Org`);
  const hr = await createTestUser(`prev-${label}-hr`);
  const finance = await createTestUser(`prev-${label}-fin`);
  const finance2 = await createTestUser(`prev-${label}-fin2`);
  const lineManager = await createTestUser(`prev-${label}-lm`);
  await addMember(hr, "hr", owner.orgId);
  await addMember(finance, "finance", owner.orgId);
  await addMember(finance2, "finance", owner.orgId);
  await addMember(lineManager, "line_manager", owner.orgId);
  return { owner, hr, finance, finance2, lineManager };
}

/** As the database owner, optionally in replica mode, in its own transaction. */
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

/** An approved timesheet day, seeded before the period is posted (triggers off). */
async function addLine(orgId: string, workerId: string, workDate: string) {
  await asDbOwner(
    `insert into public.timesheets (organisation_id, worker_id, period_start, period_end)
     values ($1, $2, private.timesheet_period_start($3::date, 20),
             private.timesheet_period_end(private.timesheet_period_start($3::date, 20)))
     on conflict (organisation_id, worker_id, period_start) do nothing`,
    [orgId, workerId, workDate],
    true,
  );
  const id = randomUUID();
  const { error } = await asDbOwner(
    `insert into public.timesheet_lines (id, organisation_id, timesheet_id, worker_id, work_date,
       shift_assignment_id, shift_id, post_id, scheduled_minutes, worked_minutes, ot_minutes,
       status, exceptions)
     select $1, $2, t.id, $3, $4, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 480,
            480, 0, 'approved', '{}'
     from public.timesheets t
     where t.organisation_id = $2 and t.worker_id = $3
       and t.period_start = private.timesheet_period_start($4::date, 20)`,
    [id, orgId, workerId, workDate],
    true,
  );
  expect(error).toBeNull();
  return id;
}

const reverse = (by: Client, orgId: string, runId: string, reason: string, notUploaded = false) =>
  by.rpc("reverse_payroll_run", {
    p_organisation_id: orgId,
    p_run_id: runId,
    p_reason: reason,
    ...(notUploaded ? { p_not_uploaded: true } : {}),
  });

const approveReversal = (by: Client, orgId: string, runId: string, notUploaded = false) =>
  by.rpc("approve_payroll_reversal", {
    p_organisation_id: orgId,
    p_run_id: runId,
    ...(notUploaded ? { p_not_uploaded: true } : {}),
  });

async function runRow(runId: string) {
  const { data, error } = await admin.from("payroll_runs").select("*").eq("id", runId).single();
  expect(error).toBeNull();
  return data!;
}

async function posted(orgId: string, day: string): Promise<boolean> {
  const { rows } = await db.query<{ posted: boolean }>(
    "select private.timesheet_period_posted($1, $2::date) as posted",
    [orgId, day],
  );
  return rows[0]!.posted;
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
});

afterAll(async () => {
  await db?.end();
});

describe("reversing an approved run before release", () => {
  let c: Company;
  let run: SeededPayrollRun;
  let lineId: string;
  let batchId: string;
  let reversalId: string;
  let paymentId: string;

  beforeAll(async () => {
    c = await company("main");
    run = await seedSubmittedRun(admin, c.owner, { count: 2 });
    lineId = await addLine(c.owner.orgId, run.workers[0]!.workerId, "2026-10-06");
    await approveRun(admin, c.owner.orgId, run.runId, c.finance);
    // The owner makes the bank file (they may, for a run they prepared).
    const made = await makeBatch(admin, c.owner.client, c.owner.orgId, run.runId);
    expect(made.error).toBeNull();
    batchId = made.batchId;
    // Finance records the PAYE payment with its receipt.
    const { data: paye } = await admin
      .from("statutory_remittances")
      .select("id, amount_kobo::text")
      .eq("run_id", run.runId)
      .eq("kind", "paye")
      .single();
    const receipt = await seedReceipt(admin, c.owner.orgId, paye!.id, c.finance.id);
    expect(receipt.error).toBeNull();
    const paid = await c.finance.client.rpc("record_statutory_payment", {
      p_organisation_id: c.owner.orgId,
      p_remittance_id: paye!.id,
      p_receipt_id: receipt.receiptId,
      p_paid_on: "2026-10-26",
      p_paid_amount_kobo: (paye as unknown as { amount_kobo: string }).amount_kobo,
      p_reference: "LIRS-REV",
    });
    expect(paid.error).toBeNull();
    paymentId = paid.data as unknown as string;
  });

  it("locks the period while the run stands", async () => {
    expect(await posted(c.owner.orgId, "2026-10-05")).toBe(true);
    const reopen = await c.owner.client.rpc("reopen_timesheet_line", {
      p_organisation_id: c.owner.orgId,
      p_line_id: lineId,
      p_reason: "Late clock-out arrived",
    });
    expect(reopen.error?.code).toBe("MLTA5");
  });

  it("is asked for by owner or finance only, with a reason", async () => {
    for (const who of [c.hr, c.lineManager]) {
      const { error } = await reverse(who.client, c.owner.orgId, run.runId, "Wrong overtime");
      expect(error?.code).toBe(DENIED);
    }
    const blank = await reverse(c.finance.client, c.owner.orgId, run.runId, "   ");
    expect(blank.error?.code).toBe("22023");
  });

  it("needs the statement that a downloaded bank file wasn't uploaded", async () => {
    const got = await download(c.owner.client, c.owner.orgId, batchId);
    expect(got.error).toBeNull();
    const { error } = await reverse(c.finance.client, c.owner.orgId, run.runId, "Wrong overtime");
    expect(error?.code).toBe("MLRV5");
  });

  it("copies every payslip and line with sign -1, summing to minus the run", async () => {
    const { data, error } = await reverse(
      c.finance.client,
      c.owner.orgId,
      run.runId,
      "Overtime at Apapa approved twice",
      true,
    );
    expect(error).toBeNull();
    reversalId = data!;
    const original = await runRow(run.runId);
    const reversal = await runRow(reversalId);
    expect(original.status).toBe("approved");
    expect(reversal).toMatchObject({
      kind: "reversal",
      status: "review",
      reverses_run_id: run.runId,
      prepared_by: c.finance.id,
      submitted_by: c.finance.id,
      worker_count: original.worker_count,
    });
    for (const f of MONEY) expect(reversal[f]).toBe(original[f]);

    const { data: slips } = await admin.from("payslips").select("*").eq("run_id", run.runId);
    const { data: copies } = await admin.from("payslips").select("*").eq("run_id", reversalId);
    expect(copies).toHaveLength(slips!.length);
    for (const copy of copies!) {
      const o = slips!.find((s) => s.id === copy.reverses_payslip_id)!;
      expect(copy.sign).toBe(-1);
      expect(o.sign).toBe(1);
      expect(copy.worker_id).toBe(o.worker_id);
      expect(copy.pay_rate_ids).toEqual([]);
      for (const f of MONEY) expect(copy[f]).toBe(o[f]);
    }
    // Signed, the run and its reversal net to zero, field by field.
    for (const f of MONEY) {
      const sum = [...slips!, ...copies!].reduce(
        (n, s) => n + BigInt(s.sign) * BigInt(s[f] as number),
        0n,
      );
      expect(sum, f).toBe(0n);
    }
    const { data: lines } = await admin
      .from("payslip_lines")
      .select("sign, amount_kobo")
      .in("run_id", [run.runId, reversalId]);
    const lineSum = lines!.reduce((n, l) => n + BigInt(l.sign) * BigInt(l.amount_kobo), 0n);
    expect(lineSum).toBe(0n);
    expect(lines!.filter((l) => l.sign === -1)).toHaveLength(lines!.length / 2);
  });

  it("allows one waiting reversal per run", async () => {
    const { error } = await reverse(c.finance2.client, c.owner.orgId, run.runId, "Again", true);
    expect(error?.code).toBe("MLRV3");
  });

  it("keeps the run from being released while its reversal waits", async () => {
    const { error } = await release(c.finance.client, c.owner.orgId, run.runId, batchId);
    expect(error?.code).toBe("MLRV9");
  });

  it("needs a second person, and 5.3's approval can't approve a reversal", async () => {
    const mine = await approveReversal(c.finance.client, c.owner.orgId, reversalId, true);
    expect(mine.error?.code).toBe("MLRV4");
    const hr = await approveReversal(c.hr.client, c.owner.orgId, reversalId, true);
    expect(hr.error?.code).toBe(DENIED);
    const clock = await admin.rpc("payroll_clock");
    await admin.rpc("record_payroll_approval_check", {
      p_organisation_id: c.owner.orgId,
      p_run_id: reversalId,
      p_actor: c.finance2.id,
      p_inputs_sha256: "a".repeat(64),
      p_read_started_at: clock.data!,
    });
    const plain = await c.finance2.client.rpc("approve_payroll_run", {
      p_organisation_id: c.owner.orgId,
      p_run_id: reversalId,
    });
    expect(plain.error).not.toBeNull();
    expect((await runRow(reversalId)).status).toBe("review");
    expect((await runRow(run.runId)).status).toBe("approved");
  });

  it("asks the approver too to confirm a downloaded file wasn't uploaded", async () => {
    const { error } = await approveReversal(c.finance2.client, c.owner.orgId, reversalId);
    expect(error?.code).toBe("MLRV5");
  });

  it("reverses the run, voids its file and remittances and frees its sources, in one step", async () => {
    const { error } = await approveReversal(c.finance2.client, c.owner.orgId, reversalId, true);
    expect(error).toBeNull();
    expect((await runRow(run.runId)).status).toBe("reversed");
    expect(await runRow(reversalId)).toMatchObject({
      status: "approved",
      approved_by: c.finance2.id,
    });

    const { data: sources } = await admin
      .from("payslip_sources")
      .select("stands")
      .eq("run_id", run.runId);
    expect(sources!.length).toBeGreaterThan(0);
    expect(sources!.every((s) => !s.stands)).toBe(true);

    const { data: batch } = await admin
      .from("payout_batches")
      .select("status, void_reason, voided_by")
      .eq("id", batchId)
      .single();
    expect(batch!.status).toBe("voided");
    expect(batch!.void_reason).toMatch(/^Run reversed/);
    expect(batch!.voided_by).toBe(c.finance2.id);
    const { data: items } = await admin
      .from("payout_items")
      .select("status")
      .eq("batch_id", batchId);
    expect(items!.every((i) => i.status !== "pending")).toBe(true);

    const { data: rems } = await admin
      .from("statutory_remittances")
      .select("id")
      .eq("run_id", run.runId);
    const { data: voids } = await admin
      .from("statutory_remittance_voids")
      .select("remittance_id, reason, voided_by")
      .eq("run_id", run.runId);
    expect(rems!.length).toBeGreaterThan(0);
    expect(voids!.map((v) => v.remittance_id).sort()).toEqual(rems!.map((r) => r.id).sort());
    expect(voids!.every((v) => v.voided_by === c.finance2.id)).toBe(true);
    // The payment already recorded stays as evidence (5.7c refunds or offsets it).
    const { data: pays } = await admin
      .from("statutory_payments")
      .select("id, entry")
      .eq("organisation_id", c.owner.orgId);
    expect(pays!.some((p) => p.id === paymentId && p.entry === "payment")).toBe(true);
    expect(pays!.some((p) => p.entry === "void")).toBe(false);

    const { data: decisions } = await admin
      .from("payroll_run_decisions")
      .select("run_id, decision, actor_id")
      .in("run_id", [run.runId, reversalId]);
    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          run_id: run.runId,
          decision: "reversed",
          actor_id: c.finance2.id,
        }),
        expect.objectContaining({
          run_id: reversalId,
          decision: "approved",
          actor_id: c.finance2.id,
        }),
        expect.objectContaining({
          run_id: reversalId,
          decision: "submitted",
          actor_id: c.finance.id,
        }),
      ]),
    );
    const { data: audit } = await admin
      .from("audit_log")
      .select("action")
      .eq("organisation_id", c.owner.orgId)
      .in("action", [
        "payroll.reversal_requested",
        "payroll.reversal_approved",
        "payroll.run_reversed",
        "payroll.remittances_voided",
      ]);
    expect(new Set(audit!.map((a) => a.action)).size).toBe(4);
  });

  it("reopens the period: no posted days, and 4.3's reopen isn't MLTA5", async () => {
    expect(await posted(c.owner.orgId, "2026-10-05")).toBe(false);
    const reopen = await c.owner.client.rpc("reopen_timesheet_line", {
      p_organisation_id: c.owner.orgId,
      p_line_id: lineId,
      p_reason: "Late clock-out arrived",
    });
    expect(reopen.error?.code).not.toBe("MLTA5");
  });

  it("refuses a payment on a reversed run's remittance", async () => {
    const { data: nsitf } = await admin
      .from("statutory_remittances")
      .select("id")
      .eq("run_id", run.runId)
      .eq("kind", "nsitf")
      .single();
    const receipt = await seedReceipt(admin, c.owner.orgId, nsitf!.id, c.finance.id);
    const paid = await c.finance.client.rpc("record_statutory_payment", {
      p_organisation_id: c.owner.orgId,
      p_remittance_id: nsitf!.id,
      p_receipt_id: receipt.receiptId,
      p_paid_on: "2026-10-26",
      p_paid_amount_kobo: "1000",
      p_reference: "NSITF-REV",
    });
    expect(paid.error).not.toBeNull();
  });

  it("lets the period run again and pay the same sources", async () => {
    const created = await c.owner.client.rpc("create_payroll_run", {
      p_organisation_id: c.owner.orgId,
      p_period_start: "2026-09-20",
    });
    expect(created.error).toBeNull();
    const docs = run.workers.map((w) =>
      resultsFor({ ...w, adjustmentId: null }, { anomalies: [] }),
    ) as { payslips: unknown[]; totals: Record<string, string | number> }[];
    const doc = docs[0]! as Record<string, unknown> & (typeof docs)[number];
    for (const other of docs.slice(1)) {
      doc.payslips.push(...other.payslips);
      for (const [k, v] of Object.entries(other.totals)) {
        const mine = doc.totals[k]!;
        doc.totals[k] = typeof v === "number" ? Number(mine) + v : String(BigInt(mine) + BigInt(v));
      }
    }
    const saved = await saveResults(admin, c.owner, created.data!, doc);
    expect(saved.error).toBeNull();

    // A correction here must name a released payslip: the reversed run's isn't.
    const correction = await c.owner.client.rpc("add_payroll_correction", {
      p_organisation_id: c.owner.orgId,
      p_run_id: created.data!,
      p_payslip_id: run.workers[0]!.payslipId,
      p_kind: "earning",
      p_label: "October correction",
      p_amount_kobo: "100000",
      p_pensionable: false,
      p_reason: "Underpaid",
    });
    expect(correction.error?.code).toBe("MLRV8");
  });

  it("never changes the reversed run or its reversal, for the database owner in replica mode too", async () => {
    for (const replica of [false, true]) {
      for (const [sql, params] of [
        ["update public.payroll_runs set status = 'approved' where id = $1", [run.runId]],
        ["update public.payroll_runs set net_kobo = net_kobo where id = $1", [reversalId]],
        ["update public.payroll_runs set status = 'released' where id = $1", [reversalId]],
        ["delete from public.payslips where run_id = $1", [reversalId]],
        ["delete from public.payslip_lines where run_id = $1", [reversalId]],
        ["update public.payslip_sources set stands = true where run_id = $1", [run.runId]],
        ["delete from public.statutory_remittance_voids where run_id = $1", [run.runId]],
        [
          "update public.statutory_remittance_voids set reason = 'x' where run_id = $1",
          [run.runId],
        ],
      ] as const) {
        const { error } = await asDbOwner(sql, [...params], replica);
        expect(error, `${sql} (replica ${replica})`).not.toBeNull();
      }
    }
    const trunc = await asDbOwner("truncate public.statutory_remittance_voids", []);
    expect(trunc.error).not.toBeNull();
  });

  it("gives signed-in users no writes on remittance voids", async () => {
    for (const client of [c.owner.client, c.finance.client]) {
      const ins = await client.from("statutory_remittance_voids").insert({
        organisation_id: c.owner.orgId,
        remittance_id: randomUUID(),
        run_id: run.runId,
        reason: "Mine",
        voided_by: c.owner.id,
      });
      expect(ins.error?.code).toBe(DENIED);
    }
    const { data } = await c.lineManager.client
      .from("statutory_remittance_voids")
      .select("id")
      .eq("organisation_id", c.owner.orgId);
    expect(data ?? []).toEqual([]);
  });
});

describe("what can't be reversed, and corrections after release", () => {
  let c: Company;
  let run: SeededPayrollRun;

  beforeAll(async () => {
    c = await company("released");
    run = await seedSubmittedRun(admin, c.owner);
    await approveRun(admin, c.owner.orgId, run.runId, c.finance);
    await releaseThroughBankFile(admin, c.owner, run.runId, c.finance);
  });

  it("refuses a released run: the money has gone", async () => {
    const { error } = await reverse(c.finance.client, c.owner.orgId, run.runId, "Too late", true);
    expect(error?.code).toBe("MLRV1");
  });

  it("refuses a draft or a run in review", async () => {
    const created = await c.owner.client.rpc("create_payroll_run", {
      p_organisation_id: c.owner.orgId,
      p_period_start: "2026-10-20",
    });
    expect(created.error).toBeNull();
    const { error } = await reverse(c.finance.client, c.owner.orgId, created.data!, "Draft", true);
    expect(error?.code).toBe("MLRV2");
  });

  it("adds a correction to a later draft naming the released payslip", async () => {
    const { data: nov } = await admin
      .from("payroll_runs")
      .select("id")
      .eq("organisation_id", c.owner.orgId)
      .eq("period_start", "2026-10-20")
      .single();
    const hr = await c.lineManager.client.rpc("add_payroll_correction", {
      p_organisation_id: c.owner.orgId,
      p_run_id: nov!.id,
      p_payslip_id: run.workers[0]!.payslipId,
      p_kind: "earning",
      p_label: "October overtime underpaid",
      p_amount_kobo: "450000",
      p_pensionable: false,
      p_reason: "6 hours of 3 Oct overtime were left out",
    });
    expect(hr.error?.code).toBe(DENIED);
    const { data: id, error } = await c.hr.client.rpc("add_payroll_correction", {
      p_organisation_id: c.owner.orgId,
      p_run_id: nov!.id,
      p_payslip_id: run.workers[0]!.payslipId,
      p_kind: "earning",
      p_label: "October overtime underpaid",
      p_amount_kobo: "450000",
      p_pensionable: false,
      p_reason: "6 hours of 3 Oct overtime were left out",
    });
    expect(error).toBeNull();
    const { data: adj } = await admin
      .from("payroll_adjustments")
      .select("worker_id, corrects_payslip_id, instalment_count, created_by")
      .eq("id", id!)
      .single();
    expect(adj).toEqual({
      worker_id: run.workers[0]!.workerId,
      corrects_payslip_id: run.workers[0]!.payslipId,
      instalment_count: 1,
      created_by: c.hr.id,
    });
    // The database checks too: a correction naming a payslip of another worker is refused.
    const other = await addPayrollWorker(admin, c.owner.orgId);
    const forged = await asDbOwner(
      `insert into public.payroll_adjustments (organisation_id, run_id, worker_id, kind, label,
         amount_kobo, series_id, reason, created_by, corrects_payslip_id)
       values ($1, $2, $3, 'earning', 'Forged', 100, gen_random_uuid(), 'Forged', $4, $5)`,
      [c.owner.orgId, nov!.id, other.workerId, c.owner.id, run.workers[0]!.payslipId],
    );
    expect(forged.error?.code).toBe("MLRV8");
  });
});

describe("a declined reversal, and the guards on a standing run", () => {
  let c: Company;
  let run: SeededPayrollRun;

  beforeAll(async () => {
    c = await company("declined");
    run = await seedSubmittedRun(admin, c.owner);
    await approveRun(admin, c.owner.orgId, run.runId, c.finance);
  });

  it("refuses every other way to reverse, free or void, for the database owner too", async () => {
    for (const replica of [false, true]) {
      const reversed = await asDbOwner(
        "update public.payroll_runs set status = 'reversed' where id = $1",
        [run.runId],
        replica,
      );
      expect(reversed.error?.code).toBe("MLRV6");
      const freed = await asDbOwner(
        "update public.payslip_sources set stands = false where run_id = $1",
        [run.runId],
        replica,
      );
      expect(freed.error?.code).toBe("MLPRD");
      const voided = await asDbOwner(
        `insert into public.statutory_remittance_voids (organisation_id, remittance_id, run_id,
           reason, voided_by)
         select m.organisation_id, m.id, m.run_id, 'Forged', $2
         from public.statutory_remittances m where m.run_id = $1`,
        [run.runId, c.owner.id],
        replica,
      );
      expect(voided.error?.code).toBe("MLRVA");
    }
  });

  it("is never submitted again; a new reversal can be asked for", async () => {
    const { data: first, error } = await reverse(
      c.finance.client,
      c.owner.orgId,
      run.runId,
      "Check",
    );
    expect(error).toBeNull();
    const declined = await c.finance2.client.rpc("return_payroll_run", {
      p_organisation_id: c.owner.orgId,
      p_run_id: first!,
      p_reason: "The run is right",
    });
    expect(declined.error).toBeNull();
    expect((await runRow(first!)).status).toBe("draft");
    expect((await runRow(run.runId)).status).toBe("approved");
    const again = await c.owner.client.rpc("submit_payroll_run", {
      p_organisation_id: c.owner.orgId,
      p_run_id: first!,
    });
    expect(again.error?.code).toBe("MLRV6");
    // Nothing is added to a reversal.
    const adj = await c.owner.client.rpc("add_payroll_adjustment", {
      p_organisation_id: c.owner.orgId,
      p_run_id: first!,
      p_worker_id: run.workers[0]!.workerId,
      p_kind: "earning",
      p_label: "Extra",
      p_amount_kobo: "100",
      p_pensionable: false,
      p_taxable: true,
      p_instalments: 1,
      p_reason: "Extra",
    });
    expect(adj.error).not.toBeNull();
    const second = await reverse(c.finance.client, c.owner.orgId, run.runId, "Check again");
    expect(second.error).toBeNull();
    expect(second.data).not.toBe(first);
  });
});

describe("the RSA PIN snapshot", () => {
  it("keeps the encrypted PIN as saved with the results, never the caller's", async () => {
    const owner = await createTenantUser("prev-pin-owner", "Reversal PIN Org");
    const pin = enc();
    const w = await addPayrollWorker(admin, owner.orgId, {
      rsa_pin_enc: pin,
      rsa_pin_last4: "1234",
    });
    const created = await owner.client.rpc("create_payroll_run", {
      p_organisation_id: owner.orgId,
      p_period_start: "2026-09-20",
    });
    expect(created.error).toBeNull();
    const saved = await saveResults(
      admin,
      owner,
      created.data!,
      resultsFor({ ...w, adjustmentId: null }, { anomalies: [] }),
    );
    expect(saved.error).toBeNull();
    const { data: worker } = await admin
      .from("workers")
      .select("rsa_pin_enc")
      .eq("id", w.workerId)
      .single();
    const slip = async () =>
      (
        await admin
          .from("payslips")
          .select("rsa_pin_enc, rsa_pin_snapshot")
          .eq("run_id", created.data!)
          .single()
      ).data!;
    expect(await slip()).toEqual({ rsa_pin_enc: worker!.rsa_pin_enc, rsa_pin_snapshot: true });
    // The worker's PIN changes later: the payslip keeps the one it was saved with.
    const changed = await admin
      .from("workers")
      .update({ rsa_pin_enc: enc(), rsa_pin_last4: "9876" })
      .eq("id", w.workerId);
    expect(changed.error).toBeNull();
    expect((await slip()).rsa_pin_enc).toBe(worker!.rsa_pin_enc);
  });
});
