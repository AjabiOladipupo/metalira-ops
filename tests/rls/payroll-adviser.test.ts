/**
 * Slice 5.9a (the tax adviser's answers of 24 Nov 2026) against the real database.
 * - Opening balances: owner and hr record them; finance reads them; admins and line managers see
 *   nothing; one in force per worker and tax year (MLYA2: correct it by superseding); refused when
 *   posted payslips already cover its months (MLYA3); insert-only for every role, the secret key
 *   and the database owner, in replica mode too (MLYA5); the import supersedes.
 * - Reliefs: declared by owner or hr; verified only with a proof on file (MLYA4); proofs only
 *   through the server's secret key, checked against the stored object; a rejection needs a note;
 *   a superseded declaration can't be verified.
 * - NHF numbers and the ITF turnover switch: owner and hr write, audited; finance reads.
 * - payroll_tax_context: owner, hr, finance (and the secret key) read headcount, the switch,
 *   go-live, and per worker the NHF number on file, the opening balance in force and the verified
 *   reliefs; others are refused.
 * - Approval extends 5.8's month checks to the tax year: refused (MLPRF) when an opening balance
 *   or a verified relief changed after the payslip's PAYE was worked out.
 * - A deduction of an overpayment paid more than 3 months ago is refused (MLYA1).
 * - NTA 2025 v2 is a company's starting rule set.
 */
import { createHash, randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NTA_2025_V2, ruleSetRulesJson } from "@/lib/payroll/rule-set";
import type { Database } from "@/types/db";

import { addPayrollWorker, OCT_START, resultsFor, saveResults, SHA } from "./helpers/payroll";
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

const DENIED = "42501";
const PDF = new TextEncoder().encode("%PDF-1.4\n% relief proof\n%%EOF\n");

let admin: Client;
let db: pg.Client;

interface Company {
  owner: TenantUser;
  hr: TestUser;
  finance: TestUser;
  finance2: TestUser;
  adminUser: TestUser;
  lineManager: TestUser;
}

async function company(label: string): Promise<Company> {
  const owner = await createTenantUser(`pad-${label}-owner`, `Adviser ${label} Org`);
  const add = async (suffix: string, role: Role) => {
    const user = await createTestUser(`pad-${label}-${suffix}`);
    const { error } = await admin
      .from("memberships")
      .insert({ organisation_id: owner.orgId, user_id: user.id, role });
    expect(error).toBeNull();
    return user;
  };
  return {
    owner,
    hr: await add("hr", "hr"),
    finance: await add("fin", "finance"),
    finance2: await add("fin2", "finance"),
    adminUser: await add("admin", "admin"),
    lineManager: await add("lm", "line_manager"),
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

const opening = (
  client: Client,
  orgId: string,
  workerId: string,
  over: Record<string, unknown> = {},
) =>
  client.rpc("record_payroll_opening_balance", {
    p_organisation_id: orgId,
    p_worker_id: workerId,
    p_tax_year: 2026,
    p_as_of_month: "2026-08-01",
    p_gross_kobo: "96000000",
    p_chargeable_kobo: "88320000",
    p_paye_kobo: "5248000",
    p_pension_kobo: "7680000",
    p_reason: "Go-live balances from the old payroll",
    ...over,
  });

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
});

afterAll(async () => {
  await db?.end();
});

describe("the starting rule set", () => {
  it("is NTA 2025 v2 from 1 Jan 2026", async () => {
    const c = await createTenantUser("pad-rules-owner", "Adviser Rules Org");
    const ensured = await c.client.rpc("ensure_tax_rule_set", { p_organisation_id: c.orgId });
    expect(ensured.error).toBeNull();
    const { data } = await admin
      .from("tax_rule_sets")
      .select("name, effective_from, rules")
      .eq("organisation_id", c.orgId);
    expect(data).toEqual([
      {
        name: "NTA 2025 v2",
        effective_from: "2026-01-01",
        rules: ruleSetRulesJson(NTA_2025_V2.rules),
      },
    ]);
  });
});

describe("opening balances", () => {
  let c: Company;
  let workerId: string;
  let firstId: string;

  beforeAll(async () => {
    c = await company("open");
    ({ workerId } = await addPayrollWorker(admin, c.owner.orgId));
  });

  it("are recorded by hr, read by finance, and invisible to admins and line managers", async () => {
    const recorded = await opening(c.hr.client, c.owner.orgId, workerId);
    expect(recorded.error).toBeNull();
    firstId = recorded.data!;
    const read = await c.finance.client.from("payroll_opening_balances").select("id");
    expect(read.data).toEqual([{ id: firstId }]);
    for (const user of [c.adminUser, c.lineManager]) {
      const none = await user.client.from("payroll_opening_balances").select("id");
      expect(none.data ?? []).toEqual([]);
    }
    const byFinance = await opening(c.finance.client, c.owner.orgId, workerId, {
      p_supersedes_id: firstId,
    });
    expect(byFinance.error?.code).toBe(DENIED);
    const { data: audit } = await admin
      .from("audit_log")
      .select("action")
      .eq("entity_id", firstId)
      .eq("action", "payroll.opening_balance_recorded");
    expect(audit).toHaveLength(1);
  });

  it("keeps one in force per worker and year: a correction supersedes it (MLYA2)", async () => {
    const second = await opening(c.hr.client, c.owner.orgId, workerId);
    expect(second.error?.code).toBe("MLYA2");
    const corrected = await opening(c.owner.client, c.owner.orgId, workerId, {
      p_supersedes_id: firstId,
      p_paye_kobo: "5000000",
    });
    expect(corrected.error).toBeNull();
    const stale = await opening(c.owner.client, c.owner.orgId, workerId, {
      p_supersedes_id: firstId,
    });
    expect(stale.error?.code).toBe("MLYA2");
  });

  it("refuses bad input: an as-of month outside the year, PAYE above gross, a personal number", async () => {
    for (const over of [
      { p_as_of_month: "2025-12-01" },
      { p_as_of_month: "2026-08-15" },
      { p_paye_kobo: "96000001" },
      { p_reason: "Account 0123456789" },
      { p_gross_kobo: "-1" },
    ]) {
      const { error } = await opening(c.hr.client, c.owner.orgId, workerId, over);
      expect(error?.code, JSON.stringify(over)).toBe("22023");
    }
  });

  it("are insert-only for every role, the secret key and the database owner (MLYA5)", async () => {
    const upd = await admin
      .from("payroll_opening_balances")
      .update({ ytd_paye_kobo: 0 })
      .eq("id", firstId)
      .select("id");
    expect(upd.data ?? []).toEqual([]);
    for (const replica of [false, true]) {
      for (const sql of [
        "update public.payroll_opening_balances set ytd_paye_kobo = 0 where id = $1",
        "delete from public.payroll_opening_balances where id = $1",
      ]) {
        const { error } = await asDbOwner(sql, [firstId], replica);
        expect(error?.code, `${sql} (replica ${replica})`).toBe("MLYA5");
      }
    }
    const trunc = await asDbOwner("truncate public.payroll_opening_balances", []);
    expect(trunc.error?.code).toBe("MLYA5");
  });

  it("are imported at go-live, superseding what is in force", async () => {
    const { workerId: other } = await addPayrollWorker(admin, c.owner.orgId);
    const imported = await c.hr.client.rpc("import_payroll_opening_balances", {
      p_organisation_id: c.owner.orgId,
      p_tax_year: 2026,
      p_as_of_month: "2026-08-01",
      p_rows: [
        {
          worker_id: workerId,
          gross_kobo: "1",
          chargeable_kobo: "1",
          paye_kobo: "0",
          pension_kobo: "0",
        },
        {
          worker_id: other,
          gross_kobo: "2",
          chargeable_kobo: "2",
          paye_kobo: "0",
          pension_kobo: "0",
        },
      ],
      p_reason: "Go-live import",
    });
    expect(imported.error).toBeNull();
    expect(imported.data).toBe(2);
    const ctx = await c.finance.client.rpc("payroll_tax_context", {
      p_organisation_id: c.owner.orgId,
      p_pay_date: "2026-10-25",
      p_worker_ids: [workerId, other],
    });
    expect(ctx.error).toBeNull();
    const workers = (
      ctx.data as { workers: { worker_id: string; opening: { gross_kobo: string } }[] }
    ).workers;
    expect(workers.find((w) => w.worker_id === workerId)?.opening.gross_kobo).toBe("1");
    expect(workers.find((w) => w.worker_id === other)?.opening.gross_kobo).toBe("2");
  });

  it("refuses a balance whose months a posted payslip already covers (MLYA3)", async () => {
    const d = await company("open3");
    const worker = await addPayrollWorker(admin, d.owner.orgId);
    const run = await submitRunFor(admin, d.owner, worker, OCT_START);
    await approveRun(admin, d.owner.orgId, run, d.finance);
    const covered = await opening(d.hr.client, d.owner.orgId, worker.workerId, {
      p_as_of_month: "2026-10-01",
    });
    expect(covered.error?.code).toBe("MLYA3");
    const before = await opening(d.hr.client, d.owner.orgId, worker.workerId, {
      p_as_of_month: "2026-09-01",
    });
    expect(before.error).toBeNull();
  });
});

describe("reliefs and their proofs", () => {
  let c: Company;
  let workerId: string;
  let declarationId: string;

  beforeAll(async () => {
    c = await company("relief");
    ({ workerId } = await addPayrollWorker(admin, c.owner.orgId));
  });

  it("are declared by hr, and verified only with a proof on file (MLYA4)", async () => {
    const declared = await c.hr.client.rpc("declare_payroll_relief", {
      p_organisation_id: c.owner.orgId,
      p_worker_id: workerId,
      p_tax_year: 2026,
      p_kind: "nhis",
      p_annual_kobo: "6000000",
      p_reason: "NHIA statement for 2026",
    });
    expect(declared.error).toBeNull();
    declarationId = declared.data!;
    const early = await c.hr.client.rpc("verify_payroll_relief", {
      p_organisation_id: c.owner.orgId,
      p_declaration_id: declarationId,
      p_decision: "verified",
    });
    expect(early.error?.code).toBe("MLYA4");
    const byFinance = await c.finance.client.rpc("declare_payroll_relief", {
      p_organisation_id: c.owner.orgId,
      p_worker_id: workerId,
      p_tax_year: 2026,
      p_kind: "rent",
      p_annual_kobo: "1",
      p_reason: "Not mine to declare",
    });
    expect(byFinance.error?.code).toBe(DENIED);
  });

  it("take a proof only from the server's secret key, checked against the stored object", async () => {
    const proofId = randomUUID();
    const args = {
      p_organisation_id: c.owner.orgId,
      p_declaration_id: declarationId,
      p_proof_id: proofId,
      p_actor: c.hr.id,
      p_document_kind: "contribution_statement",
      p_file_ext: "pdf",
      p_size_bytes: PDF.length,
      p_sha256: createHash("sha256").update(PDF).digest("hex"),
    };
    const signedIn = await c.hr.client.rpc("record_payroll_relief_proof", args);
    expect(signedIn.error).not.toBeNull();
    const missing = await admin.rpc("record_payroll_relief_proof", args);
    expect(missing.error?.code).toBe("22023");
    const path = `${c.owner.orgId}/${workerId}/${declarationId}/${proofId}.pdf`;
    const up = await admin.storage
      .from("payroll-relief-proofs")
      .upload(path, PDF, { contentType: "application/pdf" });
    expect(up.error).toBeNull();
    const recorded = await admin.rpc("record_payroll_relief_proof", args);
    expect(recorded.error).toBeNull();
    // Signed-in users can't read the bucket directly.
    const direct = await c.hr.client.storage.from("payroll-relief-proofs").download(path);
    expect(direct.data).toBeNull();
  });

  it("need a note to reject; verified, they appear in the tax context", async () => {
    const rejected = await c.hr.client.rpc("verify_payroll_relief", {
      p_organisation_id: c.owner.orgId,
      p_declaration_id: declarationId,
      p_decision: "rejected",
    });
    expect(rejected.error?.code).toBe("22023");
    const verified = await c.owner.client.rpc("verify_payroll_relief", {
      p_organisation_id: c.owner.orgId,
      p_declaration_id: declarationId,
      p_decision: "verified",
    });
    expect(verified.error).toBeNull();
    const ctx = await c.hr.client.rpc("payroll_tax_context", {
      p_organisation_id: c.owner.orgId,
      p_pay_date: "2026-10-25",
      p_worker_ids: [workerId],
    });
    expect(ctx.error).toBeNull();
    expect(
      (ctx.data as { workers: { reliefs: { id: string; kind: string; annual_kobo: string }[] }[] })
        .workers[0]!.reliefs,
    ).toEqual([{ id: declarationId, kind: "nhis", annual_kobo: "6000000" }]);
  });

  it("can't verify a superseded declaration", async () => {
    const corrected = await c.hr.client.rpc("declare_payroll_relief", {
      p_organisation_id: c.owner.orgId,
      p_worker_id: workerId,
      p_tax_year: 2026,
      p_kind: "nhis",
      p_annual_kobo: "7000000",
      p_reason: "Corrected statement",
      p_supersedes_id: declarationId,
    });
    expect(corrected.error).toBeNull();
    const stale = await c.hr.client.rpc("verify_payroll_relief", {
      p_organisation_id: c.owner.orgId,
      p_declaration_id: declarationId,
      p_decision: "verified",
    });
    expect(stale.error?.code).toBe("MLYA4");
  });
});

describe("NHF numbers, the ITF switch and the tax context", () => {
  let c: Company;
  let workerId: string;

  beforeAll(async () => {
    c = await company("ctx");
    ({ workerId } = await addPayrollWorker(admin, c.owner.orgId));
  });

  it("records an NHF number (hr) and shows only whether one is on file", async () => {
    const set = await c.hr.client.rpc("set_payroll_nhf_number", {
      p_organisation_id: c.owner.orgId,
      p_worker_id: workerId,
      p_nhf_number: "NHF-2026-0042",
      p_reason: "From the NHF card",
    });
    expect(set.error).toBeNull();
    const byFinance = await c.finance.client.rpc("set_payroll_nhf_number", {
      p_organisation_id: c.owner.orgId,
      p_worker_id: workerId,
      p_nhf_number: "NHF-1",
      p_reason: "Not mine",
    });
    expect(byFinance.error?.code).toBe(DENIED);
    const none = await c.adminUser.client.from("payroll_nhf_numbers").select("id");
    expect(none.data ?? []).toEqual([]);
    const { data: audit } = await admin
      .from("audit_log")
      .select("after")
      .eq("organisation_id", c.owner.orgId)
      .eq("action", "payroll.nhf_number_set");
    expect(audit).toEqual([{ after: { worker_id: workerId, on_file: true, last4: "0042" } }]);
  });

  it("sets the ITF switch (owner or hr, with a reason) and refuses finance", async () => {
    const byFinance = await c.finance.client.rpc("set_itf_turnover_flag", {
      p_organisation_id: c.owner.orgId,
      p_value: true,
      p_reason: "Turnover over N50m",
    });
    expect(byFinance.error?.code).toBe(DENIED);
    const set = await c.hr.client.rpc("set_itf_turnover_flag", {
      p_organisation_id: c.owner.orgId,
      p_value: true,
      p_reason: "Audited accounts show turnover above N50m",
    });
    expect(set.error).toBeNull();
  });

  it("gives the tax context to owner, hr and finance only", async () => {
    const ok = await c.finance.client.rpc("payroll_tax_context", {
      p_organisation_id: c.owner.orgId,
      p_pay_date: "2026-10-25",
      p_worker_ids: [workerId],
    });
    expect(ok.error).toBeNull();
    expect(ok.data).toMatchObject({
      version: 1,
      headcount: 1,
      itf_turnover_over_50m: true,
      go_live_month: null,
      workers: [{ worker_id: workerId, has_nhf_number: true, opening: null, reliefs: [] }],
    });
    for (const user of [c.adminUser, c.lineManager]) {
      const refused = await user.client.rpc("payroll_tax_context", {
        p_organisation_id: c.owner.orgId,
        p_pay_date: "2026-10-25",
        p_worker_ids: [workerId],
      });
      expect(refused.error?.code).toBe(DENIED);
    }
  });
});

describe("approval re-checks the tax year (5.8's month checks, extended)", () => {
  let c: Company;
  let worker: { workerId: string; payRateId: string };

  /** A submitted October run whose payslip's trace records the year so far. */
  async function submitted(openingId: string, reliefIds: string): Promise<string> {
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
                label: "Tax year so far: 1 month from October 2026",
                formula: "No earlier payslips",
                inputs: {
                  months: 1,
                  payslips: 0,
                  opening_balance_id: openingId,
                  relief_ids: reliefIds,
                },
                value_kobo: "0",
                rule_ref: "ytd",
              },
            ],
          };
        },
      },
    );
    const saved = await saveResults(admin, c.owner, created.data!, doc);
    expect(saved.error).toBeNull();
    const sub = await c.owner.client.rpc("submit_payroll_run", {
      p_organisation_id: c.owner.orgId,
      p_run_id: created.data!,
    });
    expect(sub.error).toBeNull();
    return created.data!;
  }

  async function check(runId: string, actor: TestUser) {
    const clock = await admin.rpc("payroll_clock");
    const { error } = await admin.rpc("record_payroll_approval_check", {
      p_organisation_id: c.owner.orgId,
      p_run_id: runId,
      p_actor: actor.id,
      p_inputs_sha256: SHA,
      p_read_started_at: clock.data!,
    });
    expect(error).toBeNull();
  }

  beforeAll(async () => {
    c = await company("appr");
    worker = await addPayrollWorker(admin, c.owner.orgId);
  });

  it("refuses when an opening balance was recorded after the PAYE was worked out", async () => {
    const run = await submitted("", "");
    await check(run, c.finance);
    const recorded = await opening(c.hr.client, c.owner.orgId, worker.workerId);
    expect(recorded.error).toBeNull();
    const refused = await c.finance.client.rpc("approve_payroll_run", {
      p_organisation_id: c.owner.orgId,
      p_run_id: run,
    });
    expect(refused.error?.code).toBe("MLPRF");
    // Returned and worked out again with the balance, it goes through.
    const back = await c.finance.client.rpc("return_payroll_run", {
      p_organisation_id: c.owner.orgId,
      p_run_id: run,
      p_reason: "Opening balance added",
    });
    expect(back.error).toBeNull();
  });

  it("refuses when a relief was verified after the PAYE was worked out, and approves a current one", async () => {
    const { data: runs } = await admin
      .from("payroll_runs")
      .select("id")
      .eq("organisation_id", c.owner.orgId)
      .eq("status", "draft");
    const run = runs![0]!.id;
    const { data: ob } = await admin
      .from("payroll_opening_balances")
      .select("id")
      .eq("organisation_id", c.owner.orgId);
    const openingId = ob![0]!.id;
    const save = (reliefIds: string) =>
      saveResults(
        admin,
        c.owner,
        run,
        resultsFor(
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
                    label: "Tax year so far",
                    formula: "Opening balance",
                    inputs: {
                      months: 10,
                      payslips: 0,
                      opening_balance_id: openingId,
                      relief_ids: reliefIds,
                    },
                    value_kobo: "0",
                    rule_ref: "ytd",
                  },
                ],
              };
            },
          },
        ),
      );
    expect((await save("")).error).toBeNull();
    expect(
      (
        await c.owner.client.rpc("submit_payroll_run", {
          p_organisation_id: c.owner.orgId,
          p_run_id: run,
        })
      ).error,
    ).toBeNull();
    await check(run, c.finance);
    const reliefId = await verifyRelief(
      admin,
      { client: c.hr.client, userId: c.hr.id },
      c.owner.orgId,
      worker.workerId,
      "life_assurance",
      12_000_000n,
    );
    const refused = await c.finance.client.rpc("approve_payroll_run", {
      p_organisation_id: c.owner.orgId,
      p_run_id: run,
    });
    expect(refused.error?.code).toBe("MLPRF");

    expect(
      (
        await c.finance.client.rpc("return_payroll_run", {
          p_organisation_id: c.owner.orgId,
          p_run_id: run,
          p_reason: "Relief verified",
        })
      ).error,
    ).toBeNull();
    expect((await save(reliefId)).error).toBeNull();
    expect(
      (
        await c.owner.client.rpc("submit_payroll_run", {
          p_organisation_id: c.owner.orgId,
          p_run_id: run,
        })
      ).error,
    ).toBeNull();
    await check(run, c.finance2);
    const approved = await c.finance2.client.rpc("approve_payroll_run", {
      p_organisation_id: c.owner.orgId,
      p_run_id: run,
    });
    expect(approved.error).toBeNull();
  });
});

describe("overpayments older than 3 months (Labour Act s.5(5))", () => {
  it("refuses deducting one (MLYA1) and allows a recent one", async () => {
    const c = await company("claw");
    const worker = await addPayrollWorker(admin, c.owner.orgId);
    // June 2026 (20 May to 19 Jun, paid 25 Jun) and October 2026, both released.
    const june = await submitRunFor(admin, c.owner, worker, "2026-05-20");
    await approveRun(admin, c.owner.orgId, june, c.finance);
    await releaseRun(admin, c.owner, june, c.finance);
    const oct = await submitRunFor(admin, c.owner, worker, OCT_START);
    await approveRun(admin, c.owner.orgId, oct, c.finance);
    await releaseRun(admin, c.owner, oct, c.finance);
    const nov = await c.owner.client.rpc("create_payroll_run", {
      p_organisation_id: c.owner.orgId,
      p_period_start: "2026-10-20",
    });
    expect(nov.error).toBeNull();
    const slipOf = async (runId: string) => {
      const { data } = await admin.from("payslips").select("id").eq("run_id", runId).single();
      return data!.id;
    };
    const correct = async (payslipId: string) =>
      c.owner.client.rpc("add_payroll_correction", {
        p_organisation_id: c.owner.orgId,
        p_run_id: nov.data!,
        p_payslip_id: payslipId,
        p_kind: "deduction",
        p_label: "Overpaid allowance",
        p_amount_kobo: "100000",
        p_pensionable: false,
        p_reason: "Paid twice",
      });
    const old = await correct(await slipOf(june));
    expect(old.error?.code).toBe("MLYA1");
    expect(old.error?.message).toContain("Labour Act s.5(5)");
    const recent = await correct(await slipOf(oct));
    expect(recent.error).toBeNull();
    // Unused here but keeps the period's helper honest.
    expect(periodEnd("2026-05-20")).toBe("2026-06-19");
  });
});
