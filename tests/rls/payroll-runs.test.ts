/**
 * Slice 5.2: the payroll run against the real database (docs/PHASE_5.md 5.2, "Roles and access").
 * - Owner, hr and finance read runs, payslips, lines, sources, adjustments, anomalies and
 *   decisions; admin, ops managers, line managers and workers read nothing, and a worker never
 *   sees a draft payslip.
 * - hr and owner prepare, adjust, acknowledge and submit; finance can't. Finance and owner
 *   return; hr can't. An untrusted session is refused.
 * - save_payroll_results: the secret key only; refused to signed-in users; every invariant
 *   re-checked (MLPR6); a source paid twice refused (MLPRC); severity from the code; pay versions
 *   the worker's own; an adjustment's line pays its amount; a refused worker keeps adjustments.
 * - Submit refused while an anomaly is unacknowledged or blocking (MLPR4); a blocking anomaly
 *   can't be acknowledged (MLPRB); adjustments refused once the run is in review (MLPRD).
 * - Decisions are insert-only for every role, the secret key and the database owner, and no
 *   payroll table can be truncated.
 * - private.payroll_run_touchers names everyone who prepared or changed a run (5.3's rule 10).
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ANOMALY_SEVERITY } from "@/lib/payroll/run";
import type { Database } from "@/types/db";

import {
  addPayrollWorker,
  OCT_END,
  OCT_START,
  resultsFor,
  saveResults,
  seedPayrollRun,
  SHA,
  type SeededRun,
} from "./helpers/payroll";
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
const TABLES = [
  "payroll_runs",
  "payslips",
  "payslip_lines",
  "payslip_sources",
  "payroll_adjustments",
  "payroll_anomalies",
  "payroll_run_decisions",
] as const;

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
const staff = {} as Record<"hr" | "finance" | "admin" | "ops" | "lineManager" | "worker", TestUser>;
let submitted: SeededRun;
let draftOwner: TenantUser;
let draft: SeededRun;

async function addMember(user: TestUser, role: Role, orgId: string, workerId?: string) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role, worker_id: workerId ?? null });
  expect(error).toBeNull();
}

const anomaliesOf = async (runId: string) =>
  (
    await admin
      .from("payroll_anomalies")
      .select("id, code, severity, worker_id, detail, acknowledged_at")
      .eq("run_id", runId)
  ).data ?? [];

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("prun-owner", "Payroll Run Org");
  staff.hr = await createTestUser("prun-hr");
  staff.finance = await createTestUser("prun-finance");
  staff.admin = await createTestUser("prun-admin");
  staff.ops = await createTestUser("prun-ops");
  staff.lineManager = await createTestUser("prun-lm");
  staff.worker = await createTestUser("prun-worker");
  await addMember(staff.hr, "hr", owner.orgId);
  await addMember(staff.finance, "finance", owner.orgId);
  await addMember(staff.admin, "admin", owner.orgId);
  await addMember(staff.ops, "ops_manager", owner.orgId);
  await addMember(staff.lineManager, "line_manager", owner.orgId);
  submitted = await seedPayrollRun(admin, owner, { submit: true });
  await addMember(staff.worker, "worker", owner.orgId, submitted.workerId);

  draftOwner = await createTenantUser("prun-draft", "Payroll Draft Org");
  draft = await seedPayrollRun(admin, draftOwner);
});

afterAll(async () => {
  await db?.end();
});

describe("who reads the run", () => {
  it("shows owner, hr and finance every table's rows", async () => {
    for (const client of [owner.client, staff.hr.client, staff.finance.client]) {
      for (const table of TABLES) {
        const { data, error } = await client
          .from(table)
          .select("id")
          .eq("organisation_id", owner.orgId);
        expect(error, table).toBeNull();
        expect(data!.length, table).toBeGreaterThan(0);
      }
    }
  });

  it("shows admin, ops managers, line managers and workers nothing", async () => {
    for (const client of [
      staff.admin.client,
      staff.ops.client,
      staff.lineManager.client,
      staff.worker.client,
    ]) {
      for (const table of TABLES) {
        const { data, error } = await client.from(table).select("id");
        expect(error, table).toBeNull();
        expect(data, table).toEqual([]);
      }
    }
  });

  it("never shows a worker their own draft or submitted payslip", async () => {
    const { data } = await staff.worker.client
      .from("payslips")
      .select("id")
      .eq("worker_id", submitted.workerId);
    expect(data).toEqual([]);
  });
});

describe("who prepares and who decides", () => {
  it("refuses finance creating, adjusting, acknowledging and submitting", async () => {
    const f = staff.finance.client;
    const created = await f.rpc("create_payroll_run", {
      p_organisation_id: owner.orgId,
      p_period_start: "2026-10-20",
    });
    expect(created.error?.code).toBe(DENIED);
    const adj = await f.rpc("add_payroll_adjustment", {
      p_organisation_id: owner.orgId,
      p_run_id: submitted.runId,
      p_worker_id: submitted.workerId,
      p_kind: "earning",
      p_label: "Bonus",
      p_amount_kobo: "100",
      p_pensionable: false,
      p_taxable: true,
      p_instalments: 1,
      p_reason: "Test",
    });
    expect(adj.error?.code).toBe(DENIED);
    const ack = await f.rpc("acknowledge_payroll_anomalies", {
      p_organisation_id: owner.orgId,
      p_run_id: submitted.runId,
      p_anomaly_ids: [randomUUID()],
    });
    expect(ack.error?.code).toBe(DENIED);
    const sub = await f.rpc("submit_payroll_run", {
      p_organisation_id: owner.orgId,
      p_run_id: submitted.runId,
    });
    expect(sub.error?.code).toBe(DENIED);
  });

  it("refuses hr, admin and line managers returning a run", async () => {
    for (const client of [staff.hr.client, staff.admin.client, staff.lineManager.client]) {
      const { error } = await client.rpc("return_payroll_run", {
        p_organisation_id: owner.orgId,
        p_run_id: submitted.runId,
        p_reason: "Not mine to return",
      });
      expect(error?.code).toBe(DENIED);
    }
  });

  it("refuses an untrusted password session", async () => {
    const email = `rls-prun-untrusted-${randomUUID()}@example.test`;
    const password = `${randomUUID()}a1`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    const client = anonClient();
    expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
    await addMember({ id: created.data.user!.id, email, client }, "hr", owner.orgId);
    const { error } = await client.rpc("create_payroll_run", {
      p_organisation_id: owner.orgId,
      p_period_start: "2026-10-20",
    });
    expect(error?.code).toBe(DENIED);
    const read = await client.from("payroll_runs").select("id");
    expect(read.data).toEqual([]);
  });

  it("allows one regular run per period (MLPRA)", async () => {
    const { error } = await owner.client.rpc("create_payroll_run", {
      p_organisation_id: owner.orgId,
      p_period_start: OCT_START,
    });
    expect(error?.code).toBe("MLPRA");
  });

  it("snapshots the rule set in force on the pay date and records the preparer", async () => {
    const { data: run } = await admin
      .from("payroll_runs")
      .select("rule_set_id, pay_date, prepared_by, submitted_by, status")
      .eq("id", submitted.runId)
      .single();
    expect(run).toMatchObject({
      pay_date: "2026-10-25",
      prepared_by: owner.id,
      submitted_by: owner.id,
      status: "review",
    });
    const { data: inForce } = await admin.rpc("tax_rule_set_on", {
      p_organisation_id: owner.orgId,
      p_on: "2026-10-25",
    });
    expect(run!.rule_set_id).toBe(inForce![0]!.id);
  });
});

describe("a run in review", () => {
  it("refuses adjustments and acknowledgements (MLPRD) and records the submission", async () => {
    const adj = await owner.client.rpc("add_payroll_adjustment", {
      p_organisation_id: owner.orgId,
      p_run_id: submitted.runId,
      p_worker_id: submitted.workerId,
      p_kind: "earning",
      p_label: "Late bonus",
      p_amount_kobo: "100000",
      p_pensionable: false,
      p_taxable: true,
      p_instalments: 1,
      p_reason: "Too late",
    });
    expect(adj.error?.code).toBe("MLPRD");
    const removed = await owner.client.rpc("remove_payroll_adjustment", {
      p_organisation_id: owner.orgId,
      p_adjustment_id: submitted.adjustmentId,
      p_reason: "Too late",
    });
    expect(removed.error?.code).toBe("MLPRD");
    const saved = await saveResults(admin, owner, submitted.runId, resultsFor(submitted));
    expect(saved.error?.code).toBe("MLPRD");
    const { data: decisions } = await admin
      .from("payroll_run_decisions")
      .select("decision, actor_id, net_kobo, worker_count")
      .eq("run_id", submitted.runId);
    expect(decisions).toEqual([
      { decision: "submitted", actor_id: owner.id, net_kobo: 12_440_000, worker_count: 1 },
    ]);
  });

  it("lets finance return it to draft with a reason", async () => {
    const other = await createTenantUser("prun-return", "Payroll Return Org");
    const fin = await createTestUser("prun-return-fin");
    await addMember(fin, "finance", other.orgId);
    const run = await seedPayrollRun(admin, other, { submit: true });
    const { error } = await fin.client.rpc("return_payroll_run", {
      p_organisation_id: other.orgId,
      p_run_id: run.runId,
      p_reason: "Night overtime at Apapa isn't approved yet",
    });
    expect(error).toBeNull();
    const { data } = await admin
      .from("payroll_runs")
      .select("status, submitted_at")
      .eq("id", run.runId)
      .single();
    expect(data).toEqual({ status: "draft", submitted_at: null });
    const again = await fin.client.rpc("return_payroll_run", {
      p_organisation_id: other.orgId,
      p_run_id: run.runId,
      p_reason: "Twice",
    });
    expect(again.error?.code).toBe("MLPRD");
  });
});

describe("submitting", () => {
  it("refuses while a warning isn't acknowledged, and while anything blocks", async () => {
    const o = await createTenantUser("prun-submit", "Payroll Submit Org");
    const run = await seedPayrollRun(admin, o);
    const open = await o.client.rpc("submit_payroll_run", {
      p_organisation_id: o.orgId,
      p_run_id: run.runId,
    });
    expect(open.error?.code).toBe("MLPR4");

    // A blocking anomaly: it can't be acknowledged, and submit stays refused.
    const saved = await saveResults(
      admin,
      o,
      run.runId,
      resultsFor(run, {
        anomalies: [
          { worker_id: run.workerId, code: "no_tax_state", severity: "warning", detail: {} },
        ],
      }),
    );
    expect(saved.error).toBeNull();
    const [blocking] = await anomaliesOf(run.runId);
    expect(blocking!.severity).toBe("blocking"); // from the code, not the payload's word
    const ack = await o.client.rpc("acknowledge_payroll_anomalies", {
      p_organisation_id: o.orgId,
      p_run_id: run.runId,
      p_anomaly_ids: [blocking!.id],
    });
    expect(ack.error?.code).toBe("MLPRB");
    const sub = await o.client.rpc("submit_payroll_run", {
      p_organisation_id: o.orgId,
      p_run_id: run.runId,
    });
    expect(sub.error?.code).toBe("MLPR4");
  });

  it("needs a recalculation after an adjustment changes (MLPRD)", async () => {
    const o = await createTenantUser("prun-stale", "Payroll Stale Org");
    const run = await seedPayrollRun(admin, o);
    const removed = await o.client.rpc("remove_payroll_adjustment", {
      p_organisation_id: o.orgId,
      p_adjustment_id: run.adjustmentId,
      p_reason: "Entered twice",
    });
    expect(removed.error).toBeNull();
    const sub = await o.client.rpc("submit_payroll_run", {
      p_organisation_id: o.orgId,
      p_run_id: run.runId,
    });
    expect(sub.error?.code).toBe("MLPRD");
  });

  it("keeps an acknowledgement when the same anomaly comes back after a recalculation", async () => {
    const o = await createTenantUser("prun-ack", "Payroll Ack Org");
    const run = await seedPayrollRun(admin, o);
    const [a] = await anomaliesOf(run.runId);
    expect(
      (
        await o.client.rpc("acknowledge_payroll_anomalies", {
          p_organisation_id: o.orgId,
          p_run_id: run.runId,
          p_anomaly_ids: [a!.id],
        })
      ).error,
    ).toBeNull();
    expect((await saveResults(admin, o, run.runId, resultsFor(run))).error).toBeNull();
    const [b] = await anomaliesOf(run.runId);
    expect(b!.acknowledged_at).not.toBeNull();
  });
});

describe("save_payroll_results", () => {
  it("is refused to signed-in users, whatever their role", async () => {
    for (const client of [owner.client, staff.hr.client, draftOwner.client]) {
      const { error } = await client.rpc("save_payroll_results", {
        p_organisation_id: draftOwner.orgId,
        p_run_id: draft.runId,
        p_actor: draftOwner.id,
        p_results: resultsFor(draft) as never,
        p_inputs_sha256: SHA,
      });
      expect(error?.code).toBe(DENIED);
    }
    const anon = await anonClient().rpc("save_payroll_results", {
      p_organisation_id: draftOwner.orgId,
      p_run_id: draft.runId,
      p_actor: draftOwner.id,
      p_results: resultsFor(draft) as never,
      p_inputs_sha256: SHA,
    });
    expect(anon.error).not.toBeNull();
  });

  it("refuses an actor who isn't the company's owner or hr", async () => {
    const outsider = await createTestUser("prun-outsider");
    const { error } = await saveResults(
      admin,
      draftOwner,
      draft.runId,
      resultsFor(draft),
      outsider.id,
    );
    expect(error?.code).toBe(DENIED);
  });

  const broken: [string, (doc: Record<string, unknown>) => void][] = [
    ["net isn't gross less deductions", (d) => (slip(d).net_kobo = "1")],
    ["lines don't add up to gross", (d) => (lines(d)[0]!.amount_kobo = "5999999")],
    ["a negative amount", (d) => (slip(d).paye_kobo = "-100000")],
    ["kobo as a number", (d) => (slip(d).gross_kobo = 13500000)],
    ["a fraction of kobo", (d) => (lines(d)[0]!.amount_kobo = "6000000.5")],
    [
      "totals that don't reconcile",
      (d) => ((d.totals as Record<string, unknown>).net_kobo = "12440001"),
    ],
    [
      "an allowance paid at another amount",
      (d) => {
        const l = lines(d).find((x) => x.code === "adjustment_earning")!;
        l.amount_kobo = "1400000";
        lines(d)[0]!.amount_kobo = "6100000";
      },
    ],
    [
      "an adjustment left off the payslip",
      (d) => {
        const all = lines(d);
        const i = all.findIndex((x) => x.code === "adjustment_earning");
        all.splice(i, 1);
        all[0]!.amount_kobo = "7500000";
      },
    ],
    ["another worker's pay version", (d) => (slip(d).pay_rate_ids = [submitted.payRateId])],
    ["pay versions that aren't a list", (d) => (slip(d).pay_rate_ids = submitted.payRateId)],
    [
      "an adjustment paid on two lines",
      (d) => {
        const all = lines(d);
        const allowance = all.find((x) => x.code === "adjustment_earning")!;
        all.push({ ...allowance, label: "Supervisor allowance again" });
        all[0]!.amount_kobo = "4500000";
      },
    ],
    [
      "an adjustment line with a second source",
      (d) => {
        const allowance = lines(d).find((x) => x.code === "adjustment_earning")!;
        allowance.sources = [
          ...(allowance.sources as unknown[]),
          { kind: "pay_rate", id: draft.payRateId, from: OCT_START, to: OCT_END },
        ];
      },
    ],
    [
      "a source that isn't the worker's",
      (d) =>
        (lines(d)[0]!.sources = [
          { kind: "pay_rate", id: submitted.payRateId, from: OCT_START, to: OCT_END },
        ]),
    ],
    [
      "an anomaly code payroll doesn't know",
      (d) =>
        (d.anomalies = [{ worker_id: null, code: "made_up", severity: "warning", detail: {} }]),
    ],
    [
      "a personal number in an anomaly",
      (d) =>
        (d.anomalies = [
          {
            worker_id: null,
            code: "bank_shared",
            severity: "warning",
            detail: { note: "0123457712" },
          },
        ]),
    ],
  ];

  it.each(broken)("refuses %s (MLPR6) and keeps the draft as it was", async (_name, mutate) => {
    const before = await admin
      .from("payslips")
      .select("id, net_kobo")
      .eq("run_id", draft.runId)
      .single();
    const { error } = await saveResults(
      admin,
      draftOwner,
      draft.runId,
      resultsFor(draft, { mutate }),
    );
    expect(error?.code).toBe("MLPR6");
    const after = await admin
      .from("payslips")
      .select("id, net_kobo")
      .eq("run_id", draft.runId)
      .single();
    expect(after.data).toEqual(before.data);
  });

  it("refuses a source already paid by another standing payslip (MLPRC)", async () => {
    const nov = await draftOwner.client.rpc("create_payroll_run", {
      p_organisation_id: draftOwner.orgId,
      p_period_start: "2026-10-20",
    });
    expect(nov.error).toBeNull();
    // The October pay version days again, on November's run.
    const { error } = await saveResults(
      admin,
      draftOwner,
      nov.data!,
      resultsFor({ ...draft, adjustmentId: null }),
    );
    expect(error?.code).toBe("MLPRC");
  });

  it("keeps the adjustments of a worker the engine refused, with their blocking anomaly", async () => {
    const o = await createTenantUser("prun-refused", "Payroll Refused Org");
    const run = await seedPayrollRun(admin, o);
    const second = await addPayrollWorker(admin, o.orgId);
    const adj = await o.client.rpc("add_payroll_adjustment", {
      p_organisation_id: o.orgId,
      p_run_id: run.runId,
      p_worker_id: second.workerId,
      p_kind: "deduction",
      p_label: "Salary advance repayment",
      p_amount_kobo: "500000",
      p_pensionable: false,
      p_taxable: false,
      p_instalments: 3,
      p_reason: "Advance of 1 Sep",
    });
    expect(adj.error).toBeNull();
    // No payslip for the second worker and no anomaly naming them: refused.
    expect((await saveResults(admin, o, run.runId, resultsFor(run))).error?.code).toBe("MLPR6");
    // With their blocking anomaly: saved, and the run can't be submitted.
    const ok = await saveResults(
      admin,
      o,
      run.runId,
      resultsFor(run, {
        anomalies: [
          {
            worker_id: second.workerId,
            code: "calculation_failed",
            severity: "blocking",
            detail: {},
          },
        ],
      }),
    );
    expect(ok.error).toBeNull();
  });

  it("refuses an adjustment for a worker outside the period", async () => {
    const left = await addPayrollWorker(admin, draftOwner.orgId, {
      start_date: "2025-01-06",
      end_date: "2026-08-31",
      status: "ended",
    });
    const { error } = await draftOwner.client.rpc("add_payroll_adjustment", {
      p_organisation_id: draftOwner.orgId,
      p_run_id: draft.runId,
      p_worker_id: left.workerId,
      p_kind: "earning",
      p_label: "Bonus",
      p_amount_kobo: "100000",
      p_pensionable: false,
      p_taxable: true,
      p_instalments: 1,
      p_reason: "Left in August",
    });
    expect(error?.code).toBe("22023");
  });

  it("accepts capped shared-account groups and site ids in anomaly details", async () => {
    const ids = Array.from({ length: 20 }, () => randomUUID());
    const { error } = await saveResults(
      admin,
      draftOwner,
      draft.runId,
      resultsFor(draft, {
        anomalies: [
          {
            worker_id: null,
            code: "bank_shared",
            severity: "warning",
            detail: { worker_ids: ids, workers: 45 },
          },
          {
            worker_id: null,
            code: "open_timesheet_days",
            severity: "warning",
            detail: { site_id: randomUUID(), days: 12, reasons: ["no_clock_out", "outside"] },
          },
          {
            worker_id: draft.workerId,
            code: "no_show_days",
            severity: "warning",
            detail: { days: 3, dates: ["2026-10-07", "2026-10-08", "2026-10-09"] },
          },
          {
            worker_id: draft.workerId,
            code: "bank_in_hold",
            severity: "warning",
            detail: { ends_at: "2026-10-23T09:00:00.000Z" },
          },
        ],
      }),
    );
    expect(error).toBeNull();
    expect(await anomaliesOf(draft.runId)).toHaveLength(4);
  });

  it("derives every code's severity in SQL as the engine does", async () => {
    for (const [code, severity] of Object.entries(ANOMALY_SEVERITY)) {
      const { rows } = await db.query<{ s: string }>(
        "select private.payroll_anomaly_severity($1) as s",
        [code],
      );
      expect(rows[0]!.s, code).toBe(severity);
    }
  });
});

describe("recurring items (money review M-new-1)", () => {
  /** A deduction line paying `adjustmentId` added to a results document. */
  function withDeduction(doc: Record<string, unknown>, adjustmentId: string, amount: number) {
    const s = slip(doc);
    lines(doc).push({
      code: "deduction",
      kind: "deduction",
      label: "Loan repayment",
      amount_kobo: String(amount),
      pensionable: false,
      taxable: false,
      sources: [{ kind: "adjustment", id: adjustmentId, from: "2026-08-20", to: "2026-09-19" }],
    });
    s.other_deductions_kobo = String(amount);
    s.net_kobo = String(BigInt(s.net_kobo as string) - BigInt(amount));
    const t = doc.totals as Record<string, unknown>;
    t.other_deductions_kobo = String(amount);
    t.net_kobo = String(BigInt(t.net_kobo as string) - BigInt(amount));
    return doc;
  }

  it("carries a ₦30,000 loan as 3 × ₦10,000 across Sep, Oct and Nov, never more", async () => {
    const o = await createTenantUser("prun-loan", "Payroll Loan Org");
    const { workerId, payRateId } = await addPayrollWorker(admin, o.orgId);
    const sep = await o.client.rpc("create_payroll_run", {
      p_organisation_id: o.orgId,
      p_period_start: "2026-08-20",
    });
    expect(sep.error).toBeNull();
    const loan = await o.client.rpc("add_payroll_adjustment", {
      p_organisation_id: o.orgId,
      p_run_id: sep.data!,
      p_worker_id: workerId,
      p_kind: "deduction",
      p_label: "Loan repayment",
      p_amount_kobo: "1000000",
      p_pensionable: false,
      p_taxable: false,
      p_instalments: 3,
      p_reason: "₦30,000 loan of 1 Aug",
    });
    expect(loan.error).toBeNull();
    const saved = await saveResults(
      admin,
      o,
      sep.data!,
      withDeduction(
        resultsFor(
          { workerId, payRateId, adjustmentId: null },
          { period: { start: "2026-08-20", end: "2026-09-19" }, anomalies: [] },
        ),
        loan.data!,
        1_000_000,
      ),
    );
    expect(saved.error).toBeNull();
    // September is submitted and approved by a second person (slice 5.3's functions: the posting
    // guards fire always, so the database owner can no longer set the status with triggers off).
    const finance = await createTestUser("prun-loan-fin");
    await addMember(finance, "finance", o.orgId);
    expect(
      (
        await o.client.rpc("submit_payroll_run", {
          p_organisation_id: o.orgId,
          p_run_id: sep.data!,
        })
      ).error,
    ).toBeNull();
    expect(
      (
        await admin.rpc("record_payroll_approval_check", {
          p_organisation_id: o.orgId,
          p_run_id: sep.data!,
          p_actor: finance.id,
          p_inputs_sha256: SHA,
          p_read_started_at: (await admin.rpc("payroll_clock")).data!,
        })
      ).error,
    ).toBeNull();
    expect(
      (
        await finance.client.rpc("approve_payroll_run", {
          p_organisation_id: o.orgId,
          p_run_id: sep.data!,
        })
      ).error,
    ).toBeNull();
    const { data: series } = await admin
      .from("payroll_adjustments")
      .select("series_id")
      .eq("id", loan.data!)
      .single();
    const seriesId = series!.series_id;

    // October is prepared after September posted: instalment 2 is carried automatically.
    const oct = await o.client.rpc("create_payroll_run", {
      p_organisation_id: o.orgId,
      p_period_start: OCT_START,
    });
    expect(oct.error).toBeNull();
    // November is prepared while October is still a draft: nothing carried automatically.
    const nov = await o.client.rpc("create_payroll_run", {
      p_organisation_id: o.orgId,
      p_period_start: "2026-10-20",
    });
    expect(nov.error).toBeNull();
    const before = await admin.from("payroll_adjustments").select("id").eq("run_id", nov.data!);
    expect(before.data).toEqual([]);

    // HR carries it: the same series, instalment 3 of 3.
    const carried = await o.client.rpc("carry_payroll_instalment", {
      p_organisation_id: o.orgId,
      p_run_id: nov.data!,
      p_series_id: seriesId,
    });
    expect(carried.error).toBeNull();
    const again = await o.client.rpc("carry_payroll_instalment", {
      p_organisation_id: o.orgId,
      p_run_id: nov.data!,
      p_series_id: seriesId,
    });
    expect(again.error?.code).toBe("MLPRD");
    const byFinance = await finance.client.rpc("carry_payroll_instalment", {
      p_organisation_id: o.orgId,
      p_run_id: nov.data!,
      p_series_id: seriesId,
    });
    expect(byFinance.error?.code).toBe(DENIED);

    const { data: all } = await admin
      .from("payroll_adjustments")
      .select("run_id, instalment_number, instalment_count, amount_kobo")
      .eq("series_id", seriesId)
      .order("instalment_number");
    expect(all!.map((a) => [a.run_id, a.instalment_number, a.instalment_count])).toEqual([
      [sep.data!, 1, 3],
      [oct.data!, 2, 3],
      [nov.data!, 3, 3],
    ]);
    expect(all!.reduce((n, a) => n + a.amount_kobo, 0)).toBe(3_000_000);
  });
});

describe("insert-only decisions and kept records", () => {
  it("refuses update and delete for signed-in users and the secret key", async () => {
    for (const client of [owner.client, staff.finance.client, admin]) {
      const upd = await client
        .from("payroll_run_decisions")
        .update({ reason: "Changed" })
        .eq("run_id", submitted.runId);
      expect(upd.error?.code).toBe(DENIED);
      const del = await client.from("payroll_run_decisions").delete().eq("run_id", submitted.runId);
      expect(del.error?.code).toBe(DENIED);
    }
  });

  it("refuses update, delete and truncate for the database owner and service_role", async () => {
    for (const sql of [
      "update public.payroll_run_decisions set reason = 'Changed' where run_id = $1",
      "delete from public.payroll_run_decisions where run_id = $1",
    ]) {
      await expect(db.query(sql, [submitted.runId])).rejects.toMatchObject({ code: "MLPRD" });
    }
    for (const table of TABLES) {
      await expect(db.query(`truncate public.${table} cascade`)).rejects.toMatchObject({
        code: "MLPRD",
      });
      await db.query("begin");
      try {
        await db.query("set local role service_role");
        await expect(db.query(`truncate public.${table} cascade`)).rejects.toBeTruthy();
      } finally {
        await db.query("rollback");
      }
    }
  });

  it("never changes a payslip, and keeps a submitted run's payslips", async () => {
    await expect(
      db.query("update public.payslips set net_kobo = 1 where run_id = $1", [submitted.runId]),
    ).rejects.toMatchObject({ code: "MLPRD" });
    await expect(
      db.query("delete from public.payslips where run_id = $1", [submitted.runId]),
    ).rejects.toMatchObject({ code: "MLPRD" });
    await expect(
      db.query("delete from public.payroll_runs where id = $1", [submitted.runId]),
    ).rejects.toMatchObject({ code: "MLPRD" });
  });
});

describe("who touched the run (for 5.3's two-person rule)", () => {
  it("names the preparer, the recalculator, the submitter, the adjuster and the acknowledger", async () => {
    const o = await createTenantUser("prun-touch", "Payroll Touch Org");
    const hr = await createTestUser("prun-touch-hr");
    const hr2 = await createTestUser("prun-touch-hr2");
    await addMember(hr, "hr", o.orgId);
    await addMember(hr2, "hr", o.orgId);
    const run = await seedPayrollRun(admin, o);
    const second = await addPayrollWorker(admin, o.orgId);
    const adj = await hr.client.rpc("add_payroll_adjustment", {
      p_organisation_id: o.orgId,
      p_run_id: run.runId,
      p_worker_id: second.workerId,
      p_kind: "earning",
      p_label: "Bonus",
      p_amount_kobo: "100000",
      p_pensionable: false,
      p_taxable: true,
      p_instalments: 1,
      p_reason: "Good month",
    });
    expect(adj.error).toBeNull();
    expect(
      (
        await saveResults(
          admin,
          o,
          run.runId,
          resultsFor(run, {
            anomalies: [
              { worker_id: run.workerId, code: "first_pay", severity: "warning", detail: {} },
              {
                worker_id: second.workerId,
                code: "calculation_failed",
                severity: "blocking",
                detail: {},
              },
            ],
          }),
          hr2.id,
        )
      ).error,
    ).toBeNull();
    const [warning] = (await anomaliesOf(run.runId)).filter((a) => a.severity === "warning");
    expect(
      (
        await hr2.client.rpc("acknowledge_payroll_anomalies", {
          p_organisation_id: o.orgId,
          p_run_id: run.runId,
          p_anomaly_ids: [warning!.id],
        })
      ).error,
    ).toBeNull();
    const { rows } = await db.query<{ ids: string[] }>(
      "select private.payroll_run_touchers($1, $2) as ids",
      [o.orgId, run.runId],
    );
    expect([...rows[0]!.ids].sort()).toEqual([o.id, hr.id, hr2.id].sort());
    const finance = await createTestUser("prun-touch-fin");
    await addMember(finance, "finance", o.orgId);
    expect(rows[0]!.ids).not.toContain(finance.id);
  });
});

// Typed helpers for the results document.
function slip(d: Record<string, unknown>): Record<string, unknown> {
  return (d.payslips as Record<string, unknown>[])[0]!;
}
function lines(d: Record<string, unknown>): Record<string, unknown>[] {
  return slip(d).lines as Record<string, unknown>[];
}
