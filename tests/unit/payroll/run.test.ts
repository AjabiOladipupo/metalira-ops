/**
 * Slice 5.2: the payroll run's pure part (src/lib/payroll/run.ts): adjustments in the engine,
 * the anomaly rules (MUST 4: no_rostered_days blocks; roster_pattern_unknown and a missing leave
 * pay record warn), canonical hashing that ignores key order, ITF for the run, and the results
 * payload `save_payroll_results` checks. The six golden workers run through the earnings stage
 * and gross to net together and give the accept line's totals: ₦870,000 gross, ₦55,150 PAYE,
 * ₦69,600 employee pension, ₦745,250 net, ₦974,400 employer cost.
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import golden from "../../../fixtures/october-2026-golden.json";
import { allocateKobo, parseNairaToKobo, sumKobo } from "@/lib/money";
import { describeAnomaly } from "@/lib/payroll/anomaly-text";
import type { PaySourceRef } from "@/lib/payroll/contract";
import {
  computeEarnings,
  POLICY_DEFAULTS,
  type EarningsWorker,
  type PayPolicy,
} from "@/lib/payroll/earnings";
import type { PayRateInput } from "@/lib/payroll/inputs";
import { NTA_2025_V1 } from "@/lib/payroll/rule-set";
import {
  adjustmentLabel,
  adjustmentLines,
  ANOMALY_SEVERITY,
  canonicalJson,
  itfAppliesTo,
  netChangeOverTenPercent,
  percentChange,
  previousPeriodAnomalies,
  recurringAnomalies,
  resultsPayload,
  runAnomalies,
  runTotals,
  sharedGroups,
  SHARED_IDS_SHOWN,
  workerAnomalies,
  workerHistory,
  workerPayslip,
  type RunAdjustment,
  type WorkerAnomalyInput,
} from "@/lib/payroll/run";

const OCT = { start: "2026-09-20", end: "2026-10-19" };
const MON_FRI = [1, 2, 3, 4, 5];
const POLICY: PayPolicy = {
  standardShiftMinutes: 480,
  hourlyRateDivisorDays: 20,
  workDaysPerWeek: 5,
  ...POLICY_DEFAULTS,
};
const kobo = (naira: number) => parseNairaToKobo(String(naira));

function monthlyRate(grossNaira: number): PayRateInput {
  const [basic, housing, transport] = allocateKobo(kobo(grossNaira), [5n, 3n, 2n]);
  return {
    id: randomUUID(),
    payType: "monthly",
    basic: basic!,
    housing: housing!,
    transport: transport!,
    otherAllowances: 0n,
    dailyRate: 0n,
    hourlyRate: 0n,
    effectiveFrom: "2025-01-01",
    effectiveTo: null,
  };
}

function worker(over: Partial<EarningsWorker> = {}): EarningsWorker {
  return {
    workerId: randomUUID(),
    employmentType: "permanent",
    startDate: "2025-01-06",
    endDate: null,
    usualWorkDays: null,
    payRates: [monthlyRate(120000)],
    shifts: [],
    lastRostered: null,
    lines: [],
    arrears: [],
    leave: [],
    noShowDates: [],
    openLineCount: 0,
    ...over,
  };
}

const earningsOf = (w: EarningsWorker) =>
  computeEarnings({ period: OCT, holidays: [], defaultWorkDays: MON_FRI, worker: w }, POLICY);

function adjustment(over: Partial<RunAdjustment> = {}): RunAdjustment {
  return {
    id: randomUUID(),
    workerId: randomUUID(),
    kind: "earning",
    label: "Supervisor allowance",
    amountKobo: 1_500_000n,
    pensionable: false,
    taxable: true,
    instalmentNumber: 1,
    instalmentCount: 1,
    ...over,
  };
}

describe("the October 2026 run for the six golden workers", () => {
  const workers = golden.workers.map((g) => {
    const w = worker({ payRates: [monthlyRate(g.gross)] });
    const earnings = earningsOf(w);
    return { g, w, earnings };
  });
  const itf = itfAppliesTo(
    workers.map(() => ({ employmentType: "permanent" as const, grossKobo: 1n })),
    NTA_2025_V1,
  );
  const slips = workers.map(({ g, earnings }) =>
    workerPayslip(
      {
        employmentType: "permanent",
        earnings,
        adjustments: [],
        nhfOptIn: false,
        annualRentKobo: kobo(g.annual_rent),
        carriedDeductionKobo: 0n,
      },
      NTA_2025_V1,
      { itfApplies: itf, ruleSetId: "rule-set" },
    ),
  );

  it("applies ITF with 6 workers in the levy base", () => {
    expect(itf).toBe(true);
  });

  it("matches every worker to the kobo", () => {
    slips.forEach((s, i) => {
      const g = workers[i]!.g;
      expect(s.grossKobo).toBe(kobo(g.gross));
      expect(s.payeKobo).toBe(kobo(g.paye));
      expect(s.pensionEmployeeKobo).toBe(kobo(g.pension_employee));
      expect(s.netKobo).toBe(kobo(g.net));
      expect(s.employerCostKobo).toBe(kobo(g.employer_cost));
    });
  });

  it("gives the accept line's totals", () => {
    const t = runTotals(slips);
    expect(t.grossKobo).toBe(87_000_000n);
    expect(t.payeKobo).toBe(5_515_000n);
    expect(t.pensionEmployeeKobo).toBe(6_960_000n);
    expect(t.netKobo).toBe(74_525_000n);
    expect(t.employerCostKobo).toBe(97_440_000n);
    expect(t.workerCount).toBe(6);
    expect(t.pensionEmployeeKobo + t.pensionEmployerKobo).toBe(
      kobo(golden.statutory.pension_total),
    );
    expect(t.nsitfKobo).toBe(kobo(golden.statutory.nsitf));
    expect(t.itfKobo).toBe(kobo(golden.statutory.itf));
  });

  it("explains Musa Ibrahim's PAYE of ₦5,660 in the trace", () => {
    const musa = slips[0]!;
    const steps = musa.trace;
    expect(steps.find((s) => s.step === "annual_gross")!.label).toBe("Gross pay (₦120,000 × 12)");
    expect(steps.find((s) => s.step === "taxable")!.valueKobo).toBe(125_280_000n);
    expect(steps.find((s) => s.step === "paye")!.valueKobo).toBe(566_000n);
    expect(steps.some((s) => s.label === "15% on ₦452,800")).toBe(true);
  });

  it("builds a payload whose lines add up to every payslip's totals", () => {
    const payload = resultsPayload(
      OCT,
      workers.map(({ w, earnings }, i) => ({
        workerId: w.workerId,
        employmentType: "permanent",
        taxState: "Lagos",
        pfaName: "Stanbic IBTC Pension",
        earnings,
        payslip: slips[i]!,
      })),
      [],
      itf,
    );
    expect(payload.totals.net_kobo).toBe("74525000");
    expect(payload.totals.worker_count).toBe(6);
    for (const p of payload.payslips) {
      const sum = (pred: (code: string, kind: string) => boolean) =>
        sumKobo(p.lines.filter((l) => pred(l.code, l.kind)).map((l) => BigInt(l.amount_kobo)));
      expect(sum((_c, k) => k === "earning")).toBe(BigInt(p.gross_kobo));
      expect(sum((c) => c === "paye")).toBe(BigInt(p.paye_kobo));
      expect(sum((c) => c === "pension_employee")).toBe(BigInt(p.pension_employee_kobo));
      expect(sum((c) => c === "pension_employer")).toBe(BigInt(p.pension_employer_kobo));
      expect(BigInt(p.net_kobo)).toBe(
        BigInt(p.gross_kobo) -
          BigInt(p.paye_kobo) -
          BigInt(p.pension_employee_kobo) -
          BigInt(p.nhf_kobo) -
          BigInt(p.other_deductions_kobo),
      );
      expect(p.trace.trace_version).toBe(1);
      // Salary lines name the pay version and its days in the cycle.
      const salary = p.lines.find((l) => l.code === "basic")!;
      expect(salary.sources).toEqual([
        expect.objectContaining({ kind: "pay_rate", from: OCT.start, to: OCT.end, off_day: false }),
      ]);
    }
    expect(JSON.stringify(payload)).not.toMatch(/"(nin|bvn|rsa_pin|tin|bank_account)/);
  });
});

describe("adjustments in the engine", () => {
  it("adds an earning to gross (taxed, not in the NHF base) and a deduction after tax", () => {
    const w = worker();
    const allowance = adjustment({ workerId: w.workerId });
    const advance = adjustment({
      workerId: w.workerId,
      kind: "deduction",
      label: "Salary advance repayment",
      amountKobo: 1_000_000n,
      pensionable: false,
      taxable: false,
      instalmentNumber: 2,
      instalmentCount: 3,
    });
    const base = workerPayslip(
      {
        employmentType: "permanent",
        earnings: earningsOf(w),
        adjustments: [],
        nhfOptIn: false,
        annualRentKobo: 36_000_000n,
        carriedDeductionKobo: 0n,
      },
      NTA_2025_V1,
      { itfApplies: true, ruleSetId: "x" },
    );
    const withBoth = workerPayslip(
      {
        employmentType: "permanent",
        earnings: earningsOf(w),
        adjustments: [allowance, advance],
        nhfOptIn: false,
        annualRentKobo: 36_000_000n,
        carriedDeductionKobo: 0n,
      },
      NTA_2025_V1,
      { itfApplies: true, ruleSetId: "x" },
    );
    expect(withBoth.grossKobo).toBe(base.grossKobo + 1_500_000n);
    // Not pensionable: the employee pension doesn't move; PAYE rises on the extra pay.
    expect(withBoth.pensionEmployeeKobo).toBe(base.pensionEmployeeKobo);
    expect(withBoth.payeKobo).toBeGreaterThan(base.payeKobo);
    expect(withBoth.otherDeductionsKobo).toBe(1_000_000n);
    const deduction = withBoth.lines.find((l) => l.code === "deduction")!;
    expect(deduction.label).toBe("Salary advance repayment, 2 of 3");
    expect(deduction.sources).toEqual([{ kind: "adjustment", id: advance.id }]);
    const earning = withBoth.lines.find((l) => l.code === "adjustment_earning")!;
    expect(earning.sources).toEqual([{ kind: "adjustment", id: allowance.id }]);
    expect(withBoth.trace.some((s) => s.step === "adjustment_earning")).toBe(true);
  });

  it("puts a pensionable earning in the pension base", () => {
    const { earnings } = adjustmentLines([adjustment({ pensionable: true })]);
    expect(earnings[0]).toMatchObject({ pensionable: true, nhfBase: false, taxable: true });
  });

  it("labels recurring items with their instalment", () => {
    expect(adjustmentLabel({ label: "Loan", instalmentNumber: 1, instalmentCount: 1 })).toBe(
      "Loan",
    );
    expect(adjustmentLabel({ label: "Loan", instalmentNumber: 2, instalmentCount: 3 })).toBe(
      "Loan, 2 of 3",
    );
  });
});

describe("anomaly rules", () => {
  const base = (over: Partial<WorkerAnomalyInput> = {}): WorkerAnomalyInput => {
    const w = worker();
    const earnings = earningsOf(w);
    return {
      workerId: w.workerId,
      employmentType: "permanent",
      startDate: "2025-01-06",
      endDate: null,
      period: OCT,
      taxState: "Lagos",
      pfaName: "Stanbic IBTC Pension",
      hasRsaPin: true,
      earningsFlags: [],
      noShowDates: [],
      payslip: workerPayslip(
        {
          employmentType: "permanent",
          earnings,
          adjustments: [],
          nhfOptIn: false,
          annualRentKobo: 0n,
          carriedDeductionKobo: 0n,
        },
        NTA_2025_V1,
        { itfApplies: true, ruleSetId: "x" },
      ),
      bank: {
        missing: false,
        inHold: false,
        holdEndsAt: null,
        notChecked: false,
        unreadable: false,
      },
      previousNetKobo: null,
      paidBefore: true,
      rules: NTA_2025_V1,
      ...over,
    };
  };
  const codes = (over: Partial<WorkerAnomalyInput> = {}) =>
    workerAnomalies(base(over)).map((a) => `${a.code}:${a.severity}`);

  it("raises nothing for a clean worker", () => {
    expect(codes()).toEqual([]);
  });

  it("blocks on no pay rate, no rostered days, no tax state and a refused calculation", () => {
    expect(codes({ earningsFlags: ["no_pay_rate"] })).toContain("no_pay_rate:blocking");
    expect(codes({ earningsFlags: ["no_rostered_days"] })).toContain("no_rostered_days:blocking");
    expect(codes({ taxState: null })).toContain("no_tax_state:blocking");
    expect(codes({ payslip: null })).toContain("calculation_failed:blocking");
  });

  it("warns on a guessed roster pattern and a missing leave pay record (MUST 4)", () => {
    expect(codes({ earningsFlags: ["roster_pattern_unknown", "leave_pay_missing"] })).toEqual([
      "roster_pattern_unknown:warning",
      "leave_pay_missing:warning",
    ]);
    expect(ANOMALY_SEVERITY.no_rostered_days).toBe("blocking");
    expect(ANOMALY_SEVERITY.roster_pattern_unknown).toBe("warning");
    expect(ANOMALY_SEVERITY.leave_pay_missing).toBe("warning");
  });

  it("warns on bank details missing, in the hold, not checked or unreadable", () => {
    const bank = {
      missing: false,
      inHold: false,
      holdEndsAt: null,
      notChecked: false,
      unreadable: false,
    };
    expect(codes({ bank: { ...bank, missing: true } })).toEqual(["bank_missing:warning"]);
    expect(
      workerAnomalies(
        base({ bank: { ...bank, inHold: true, holdEndsAt: "2026-10-23T09:00:00Z" } }),
      ),
    ).toEqual([
      expect.objectContaining({
        code: "bank_in_hold",
        detail: { ends_at: "2026-10-23T09:00:00Z" },
      }),
    ]);
    expect(codes({ bank: { ...bank, notChecked: true } })).toEqual(["bank_not_checked:warning"]);
    expect(codes({ bank: { ...bank, unreadable: true } })).toEqual(["bank_unreadable:warning"]);
  });

  it("flags first pay, final pay, no-show days and missing pension details", () => {
    expect(codes({ paidBefore: false, startDate: "2026-10-01" })).toContain("first_pay:warning");
    expect(codes({ paidBefore: false, startDate: "2025-01-06" })).not.toContain(
      "first_pay:warning",
    );
    expect(codes({ endDate: "2026-10-05" })).toContain("final_pay:warning");
    expect(codes({ noShowDates: ["2026-10-07"] })).toContain("no_show_days:warning");
    expect(codes({ pfaName: null })).toContain("no_pension_details:warning");
    expect(codes({ hasRsaPin: false })).toContain("no_pension_details:warning");
  });

  it("flags a net change over 10% either way, and only then", () => {
    const net = base().payslip!.netKobo; // ₦104,740 for ₦120,000 with no rent
    expect(codes({ previousNetKobo: net })).toEqual([]);
    expect(codes({ previousNetKobo: (net * 100n) / 111n })).toContain("net_change:warning");
    expect(netChangeOverTenPercent(100_000n, 110_000n)).toBe(false);
    expect(netChangeOverTenPercent(100_000n, 110_001n)).toBe(true);
    expect(netChangeOverTenPercent(100_000n, 89_999n)).toBe(true);
    expect(percentChange(100_000n, 112_000n)).toBe(12);
    expect(percentChange(100_000n, 88_000n)).toBe(-12);
  });

  it("leaves daily workers out of the tax-state check", () => {
    expect(codes({ employmentType: "daily", taxState: null })).not.toContain(
      "no_tax_state:blocking",
    );
  });

  it("lists open timesheet days per site (by id, no name) and shared accounts by worker ids only", () => {
    const a = randomUUID();
    const b = randomUUID();
    const site = randomUUID();
    const run = runAnomalies(
      [
        { siteId: site, days: 2, reasons: ["overtime", "outside"] },
        { siteId: null, days: 1, reasons: [] },
      ],
      [[b, a]],
    );
    expect(run).toEqual([
      {
        workerId: null,
        code: "open_timesheet_days",
        severity: "warning",
        detail: { days: 1, reasons: [] },
      },
      {
        workerId: null,
        code: "open_timesheet_days",
        severity: "warning",
        detail: { site_id: site, days: 2, reasons: ["outside", "overtime"] },
      },
      {
        workerId: null,
        code: "bank_shared",
        severity: "warning",
        detail: { worker_ids: [a, b].sort(), workers: 2 },
      },
    ]);
  });

  it("names at most 20 workers of a shared account, with the full count, within the detail limit", () => {
    const group = Array.from({ length: 45 }, () => randomUUID());
    const [shared] = runAnomalies([], [group]);
    expect(shared!.detail.workers).toBe(45);
    expect(shared!.detail.worker_ids).toHaveLength(SHARED_IDS_SHOWN);
    expect(SHARED_IDS_SHOWN).toBe(20);
    // The SQL check: detail under 4 KB and no run of 10 digits outside ids.
    const text = JSON.stringify(shared!.detail);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(4096);
    expect(describeAnomaly("bank_shared", shared!.detail, null, () => "W").title).toBe(
      "Shared bank account · 45 workers",
    );
    expect(describeAnomaly("bank_shared", shared!.detail, null, () => "W").body).toContain(
      "and 25 more share one account number",
    );
  });

  it("flags net cut to ₦0 with a carried deduction", () => {
    const w = worker();
    const slip = workerPayslip(
      {
        employmentType: "permanent",
        earnings: earningsOf(w),
        adjustments: [
          adjustment({
            workerId: w.workerId,
            kind: "deduction",
            label: "Loan",
            amountKobo: 50_000_000n,
            pensionable: false,
            taxable: false,
          }),
        ],
        nhfOptIn: false,
        annualRentKobo: 0n,
        carriedDeductionKobo: 0n,
      },
      NTA_2025_V1,
      { itfApplies: true, ruleSetId: "x" },
    );
    expect(slip.netKobo).toBe(0n);
    expect(slip.carriedForwardKobo).toBeGreaterThan(0n);
    expect(codes({ payslip: slip })).toContain("deduction_cut:warning");
  });

  it("groups workers holding the same value, and nobody else", () => {
    const groups = sharedGroups(
      new Map([
        ["w1", "0123456789"],
        ["w2", "9999999999"],
        ["w3", "0123456789"],
      ]),
    );
    expect(groups).toEqual([["w1", "w3"]]);
  });

  it("keeps personal numbers out of every anomaly's detail", () => {
    const all = [
      ...workerAnomalies(
        base({
          paidBefore: false,
          startDate: "2026-10-01",
          endDate: "2026-10-05",
          noShowDates: ["2026-10-07"],
          previousNetKobo: 1_000_000_000n,
          pfaName: null,
          bank: {
            missing: false,
            inHold: true,
            holdEndsAt: "2026-10-23T09:00:00Z",
            notChecked: true,
            unreadable: true,
          },
        }),
      ),
      ...runAnomalies(
        [{ siteId: randomUUID(), days: 1, reasons: [] }],
        [[randomUUID(), randomUUID()]],
      ),
    ];
    for (const a of all) {
      const text = JSON.stringify(a.detail).replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        "",
      );
      expect(text, a.code).not.toMatch(/[0-9]{10}/);
    }
  });

  it("describes each anomaly in plain words, numbers first", () => {
    expect(describeAnomaly("net_change", { percent: 12 }, "Ibrahim Sani").title).toBe(
      "Up 12% on last month · Ibrahim Sani",
    );
    expect(
      describeAnomaly("open_timesheet_days", { site_name: "VI Tower", days: 1, reasons: [] }, null)
        .title,
    ).toBe("1 timesheet day still open · VI Tower");
    expect(
      describeAnomaly("bank_shared", { worker_ids: ["a", "b"] }, null, (id) =>
        id === "a" ? "Peter Ade" : "Peter Adewale",
      ).body,
    ).toBe("Peter Ade and Peter Adewale share one account number. Check before approving.");
  });
});

describe("history from earlier runs (money review M3)", () => {
  const slip = (net: bigint, carried: bigint) => ({ netKobo: net, carriedForwardKobo: carried });
  const w = "w1";

  it("takes net and carry from the period just before when it is posted", () => {
    const h = workerHistory(
      w,
      { periodStart: "2026-08-20", posted: true, slips: new Map([[w, slip(100n, 7n)]]) },
      new Map([[w, slip(90n, 3n)]]),
    );
    expect(h).toEqual({ previousNetKobo: 100n, carriedKobo: 7n, paidBefore: true });
  });

  it("keeps the worker's own latest carry when they had no payslip in the period before", () => {
    const h = workerHistory(
      w,
      { periodStart: "2026-08-20", posted: true, slips: new Map() },
      new Map([[w, slip(90n, 3n)]]),
    );
    expect(h).toEqual({ previousNetKobo: null, carriedKobo: 3n, paidBefore: true });
  });

  it("ignores an unposted period before for net, and blocks the run", () => {
    const previous = {
      periodStart: "2026-08-20",
      posted: false,
      slips: new Map([[w, slip(100n, 7n)]]),
    };
    expect(workerHistory(w, previous, new Map())).toEqual({
      previousNetKobo: null,
      carriedKobo: 0n,
      paidBefore: false,
    });
    expect(previousPeriodAnomalies(previous)).toEqual([
      {
        workerId: null,
        code: "previous_not_posted",
        severity: "blocking",
        detail: { period_start: "2026-08-20" },
      },
    ]);
    expect(previousPeriodAnomalies({ ...previous, posted: true })).toEqual([]);
    expect(previousPeriodAnomalies(null)).toEqual([]);
  });

  it("flags a recurring item of the period before that this run doesn't carry", () => {
    const series = [
      { seriesId: "s1", workerId: w, instalmentNumber: 1, instalmentCount: 3 },
      { seriesId: "s2", workerId: w, instalmentNumber: 3, instalmentCount: 3 },
      { seriesId: "s3", workerId: w, instalmentNumber: 1, instalmentCount: 2 },
    ];
    expect(recurringAnomalies(series, new Set(["s3"]))).toEqual([
      {
        workerId: w,
        code: "recurring_not_carried",
        severity: "warning",
        detail: { series_id: "s1", next: 2, of: 3 },
      },
    ]);
  });
});

describe("canonical inputs", () => {
  it("ignores key order at every depth and keeps array order", () => {
    const a = canonicalJson({ b: 1, a: { d: [1, 2], c: "x" }, n: 5n });
    const b = canonicalJson({ n: 5n, a: { c: "x", d: [1, 2] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":"x","d":[1,2]},"b":1,"n":"5"}');
    expect(canonicalJson({ d: [2, 1] })).not.toBe(canonicalJson({ d: [1, 2] }));
  });

  it("drops undefined keys as JSON does", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
});

describe("ITF for the run", () => {
  it("applies from 5 workers with pay in the levy base, daily workers left out", () => {
    const p = { employmentType: "permanent" as const, grossKobo: 1n };
    const d = { employmentType: "daily" as const, grossKobo: 1n };
    expect(itfAppliesTo([p, p, p, p], NTA_2025_V1)).toBe(false);
    expect(itfAppliesTo([p, p, p, p, p], NTA_2025_V1)).toBe(true);
    expect(itfAppliesTo([p, p, p, p, d], NTA_2025_V1)).toBe(false);
    expect(itfAppliesTo([p, p, p, p, { ...p, grossKobo: 0n }], NTA_2025_V1)).toBe(false);
  });
});

describe("off-day sources", () => {
  it("marks a sixth shift paid as off-day work, so arrears can count the week's paid off days", () => {
    const week = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"];
    const mk = (d: string) => ({
      id: randomUUID(),
      workDate: d,
      workedMinutes: 480,
      otMinutes: 0,
      hasShift: true,
      projectId: null,
    });
    const sixth = mk("2026-10-03");
    const e = earningsOf(worker({ lines: [...week.map(mk), sixth] }));
    const off = e.lines.find((l) => l.code === "off_day")!;
    expect(off.sources).toEqual<PaySourceRef[]>([
      { kind: "timesheet_line", id: sixth.id, workDate: "2026-10-03", offDay: true },
    ]);
    const payload = resultsPayload(
      OCT,
      [
        {
          workerId: randomUUID(),
          employmentType: "permanent",
          taxState: "Lagos",
          pfaName: null,
          earnings: e,
          payslip: workerPayslip(
            {
              employmentType: "permanent",
              earnings: e,
              adjustments: [],
              nhfOptIn: false,
              annualRentKobo: 0n,
              carriedDeductionKobo: 0n,
            },
            NTA_2025_V1,
            { itfApplies: false, ruleSetId: "x" },
          ),
        },
      ],
      [],
      false,
    );
    const stored = payload.payslips[0]!.lines.find((l) => l.code === "off_day")!.sources[0]!;
    expect(stored).toEqual({
      kind: "timesheet_line",
      id: sixth.id,
      from: "2026-10-03",
      to: "2026-10-03",
      off_day: true,
    });
  });
});
