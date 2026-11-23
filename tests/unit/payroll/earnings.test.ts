/**
 * Slice 5.1: the earnings stage (docs/PHASE_5.md "Earnings rules (5.1)"). The October 2026 cycle
 * runs Sunday 20 Sep to Monday 19 Oct 2026; with Monday-to-Friday days it has 21 rostered days.
 * The worker is on ₦120,000 a month: ₦60,000 basic, ₦36,000 housing, ₦24,000 transport (the
 * golden split), so the normal hourly rate is ₦120,000 ÷ 160 = ₦750 (1,250 kobo a minute).
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { addDays } from "@/lib/dates";
import { allocateKobo, roundHalfUp, sumKobo } from "@/lib/money";
import type { EarningLine } from "@/lib/payroll/earning-lines";
import {
  computeEarnings,
  POLICY_DEFAULTS,
  type EarningsInput,
  type EarningsWorker,
  type PayPolicy,
} from "@/lib/payroll/earnings";
import { parsePayrollInputs, rosteredCalendar, type PayRateInput } from "@/lib/payroll/inputs";

const OCT = { start: "2026-09-20", end: "2026-10-19" };
const NOV = { start: "2026-10-20", end: "2026-11-19" };
const MON_FRI = [1, 2, 3, 4, 5];
const POLICY: PayPolicy = {
  standardShiftMinutes: 480,
  hourlyRateDivisorDays: 20,
  workDaysPerWeek: 5,
  ...POLICY_DEFAULTS,
};

function monthly(over: Partial<PayRateInput> = {}): PayRateInput {
  return {
    id: randomUUID(),
    payType: "monthly",
    basic: 6_000_000n,
    housing: 3_600_000n,
    transport: 2_400_000n,
    otherAllowances: 0n,
    dailyRate: 0n,
    hourlyRate: 0n,
    effectiveFrom: "2025-01-01",
    effectiveTo: null,
    ...over,
  };
}

function worker(over: Partial<EarningsWorker> = {}): EarningsWorker {
  return {
    workerId: randomUUID(),
    employmentType: "permanent",
    startDate: "2025-01-06",
    endDate: null,
    usualWorkDays: null,
    payRates: [monthly()],
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

function line(workDate: string, workedMinutes: number, otMinutes = 0, hasShift = true) {
  return { id: randomUUID(), workDate, workedMinutes, otMinutes, hasShift, projectId: null };
}

function run(w: EarningsWorker, over: Partial<EarningsInput> = {}) {
  return computeEarnings(
    { period: OCT, holidays: [], defaultWorkDays: MON_FRI, worker: w, ...over },
    POLICY,
  );
}

const total = (lines: EarningLine[]) => sumKobo(lines.map((l) => l.amountKobo));
const byCode = (lines: EarningLine[], code: EarningLine["code"]) =>
  lines.filter((l) => l.code === code);
const amount = (lines: EarningLine[], code: EarningLine["code"]) => total(byCode(lines, code));

describe("monthly salary and proration", () => {
  it("pays exactly the monthly gross for a whole cycle on one pay rate", () => {
    const r = run(worker());
    expect(r.days).toMatchObject({ cycle: 30, rostered: 21, employedRostered: 21 });
    expect(amount(r.lines, "basic")).toBe(6_000_000n);
    expect(amount(r.lines, "housing")).toBe(3_600_000n);
    expect(amount(r.lines, "transport")).toBe(2_400_000n);
    expect(total(r.lines)).toBe(12_000_000n);
    expect(r.flags).toEqual([]);
    const basic = byCode(r.lines, "basic")[0]!;
    expect(basic).toMatchObject({ pensionable: true, nhfBase: true, taxable: true });
    expect(byCode(r.lines, "housing")[0]).toMatchObject({ pensionable: true, nhfBase: false });
    expect(basic.sources).toEqual([
      { kind: "pay_rate", id: r.payRateIds[0], from: OCT.start, to: OCT.end },
    ]);
  });

  it("keeps other allowances in gross but out of the pension base", () => {
    const r = run(worker({ payRates: [monthly({ otherAllowances: 1_000_000n })] }));
    expect(total(r.lines)).toBe(13_000_000n);
    expect(byCode(r.lines, "other_allowances")[0]).toMatchObject({
      amountKobo: 1_000_000n,
      pensionable: false,
      nhfBase: false,
    });
  });

  it("prorates a joiner on Thursday 1 Oct by rostered days: 13 of 21, rounded once", () => {
    const r = run(worker({ startDate: "2026-10-01" }));
    expect(r.days).toMatchObject({ rostered: 21, employedRostered: 13 });
    // ₦120,000 x 13 ÷ 21 = ₦74,285.714..., rounded half up once to the kobo.
    expect(total(r.lines)).toBe(roundHalfUp(12_000_000n * 13n, 21n));
    expect(total(r.lines)).toBe(7_428_571n);
    expect(byCode(r.lines, "basic")[0]!.label).toBe("Basic, 1 to 19 Oct (13 of 21 days)");
    expect(byCode(r.lines, "basic")[0]!.sources[0]).toMatchObject({
      from: "2026-10-01",
      to: "2026-10-19",
    });
  });

  it("prorates a joiner whose roster starts on their first day (days before it are usual days)", () => {
    const shifts = ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06"].map((date) => ({
      date,
      onLeave: false,
    }));
    const r = run(worker({ startDate: "2026-10-01", shifts, lastRostered: "2026-10-06" }));
    // Employed: 4 shifts up to the 6th, then usual days 7 to 19 Oct (9): 13 of 21.
    expect(r.days).toMatchObject({ rostered: 21, employedRostered: 13 });
  });

  it("prorates a leaver on Monday 5 Oct: 11 of 21", () => {
    const r = run(worker({ endDate: "2026-10-05" }));
    expect(r.days.employedRostered).toBe(11);
    expect(total(r.lines)).toBe(6_285_714n);
  });

  it("splits the components with allocateKobo so they sum to the rounded total", () => {
    const rate = monthly({
      basic: 6_543_211n,
      housing: 3_210_007n,
      transport: 1_234_567n,
      otherAllowances: 99_999n,
    });
    for (let i = 1; i < 30; i += 1) {
      const startDate = addDays(OCT.start, i);
      const r = run(worker({ payRates: [rate], startDate }));
      const gross = rate.basic + rate.housing + rate.transport + rate.otherAllowances;
      const salary = r.lines.filter((l) =>
        ["basic", "housing", "transport", "other_allowances"].includes(l.code),
      );
      const expected = roundHalfUp(gross * BigInt(r.days.employedRostered), 21n);
      expect(total(salary)).toBe(expected);
      expect(salary.map((l) => l.amountKobo)).toEqual(
        allocateKobo(expected, [rate.basic, rate.housing, rate.transport, rate.otherAllowances]),
      );
    }
  });

  it("splits a mid-cycle rate change by rostered days and prices overtime at the rate on the day", () => {
    const v1 = monthly({ effectiveTo: "2026-10-04" });
    const v2 = monthly({
      effectiveFrom: "2026-10-05",
      basic: 7_500_000n,
      housing: 4_500_000n,
      transport: 3_000_000n,
    });
    const r = run(
      worker({
        payRates: [v1, v2],
        lines: [line("2026-10-02", 480, 60), line("2026-10-06", 480, 60)],
      }),
    );
    const salary1 = r.lines.filter((l) =>
      l.sources.some((s) => s.kind === "pay_rate" && s.id === v1.id),
    );
    const salary2 = r.lines.filter((l) =>
      l.sources.some((s) => s.kind === "pay_rate" && s.id === v2.id),
    );
    expect(total(salary1)).toBe(roundHalfUp(12_000_000n * 10n, 21n)); // 5,714,286
    expect(total(salary2)).toBe(roundHalfUp(15_000_000n * 11n, 21n)); // 7,857,143
    const ot = byCode(r.lines, "overtime");
    expect(ot).toHaveLength(2);
    expect(ot.map((l) => l.amountKobo).sort()).toEqual([75_000n, 93_750n]);
    expect(r.payRateIds.sort()).toEqual([v1.id, v2.id].sort());
  });

  it("flags days with no pay rate and pays only the days covered", () => {
    const r = run(worker({ payRates: [monthly({ effectiveFrom: "2026-10-05" })] }));
    expect(r.flags).toContain("no_pay_rate");
    expect(r.days.unratedDates).toHaveLength(10);
    expect(total(r.lines)).toBe(roundHalfUp(12_000_000n * 11n, 21n));
  });

  it("pays nothing and flags a worker with no pay rate at all", () => {
    const r = run(worker({ payRates: [], lines: [line("2026-10-01", 480, 30)] }));
    expect(r.lines).toEqual([]);
    expect(r.flags).toContain("no_pay_rate");
  });

  it("counts a guard's own roster: weekend shifts are working days, weekdays without a shift are off", () => {
    const shifts = ["2026-09-26", "2026-09-27", "2026-10-03", "2026-10-04"].map((date) => ({
      date,
      onLeave: false,
    }));
    const calendar = rosteredCalendar(
      OCT,
      {
        startDate: "2025-01-01",
        endDate: null,
        usualWorkDays: null,
        shifts,
        lastRostered: "2026-10-04",
      },
      MON_FRI,
    );
    const working = calendar.filter((d) => d.working).map((d) => d.date);
    // 4 shifts, then usual Monday-to-Friday days from 5 Oct (11).
    expect(working.slice(0, 4)).toEqual(shifts.map((s) => s.date));
    expect(working).toHaveLength(15);
  });

  it("keeps a shift approved leave removed as a working day", () => {
    const calendar = rosteredCalendar(
      OCT,
      {
        startDate: "2025-01-01",
        endDate: null,
        usualWorkDays: null,
        shifts: [{ date: "2026-10-04", onLeave: true }],
        lastRostered: "2026-10-04",
      },
      MON_FRI,
    );
    expect(calendar.find((d) => d.date === "2026-10-04")!.working).toBe(true);
  });
});

describe("overtime, off days and public holidays", () => {
  it("pays no overtime for a 12-hour shift worked in full", () => {
    const r = run(worker({ lines: [line("2026-10-01", 720, 0)] }));
    expect(byCode(r.lines, "overtime")).toEqual([]);
    expect(total(r.lines)).toBe(12_000_000n);
  });

  it("pays 20 overtime minutes exactly at the normal hourly rate (1.0x)", () => {
    const l = line("2026-10-01", 480, 20);
    const r = run(worker({ lines: [l] }));
    const ot = byCode(r.lines, "overtime");
    expect(ot).toHaveLength(1);
    expect(ot[0]).toMatchObject({
      amountKobo: 25_000n,
      pensionable: false,
      nhfBase: false,
      taxable: true,
    });
    expect(ot[0]!.label).toBe("Overtime, 20 min at ₦750.00 an hour");
    expect(ot[0]!.sources).toEqual([{ kind: "timesheet_line", id: l.id, workDate: "2026-10-01" }]);
  });

  it("rounds overtime once per pay version, not per day", () => {
    const rate = monthly({ basic: 6_000_001n }); // 1,250.0001... kobo a minute
    const r = run(
      worker({ payRates: [rate], lines: [line("2026-10-01", 480, 1), line("2026-10-02", 480, 1)] }),
    );
    const gross = 12_000_001n;
    expect(amount(r.lines, "overtime")).toBe(roundHalfUp(gross * 2n, 9_600n));
    expect(byCode(r.lines, "overtime")).toHaveLength(1);
  });

  it("pays a sixth shift in a week as one 8-hour overtime shift, not its minutes", () => {
    const week = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"];
    const sixth = line("2026-10-03", 720, 90);
    const r = run(worker({ lines: [...week.map((d) => line(d, 480)), sixth] }));
    const off = byCode(r.lines, "off_day");
    expect(off).toHaveLength(1);
    expect(off[0]!.amountKobo).toBe(480n * 1_250n);
    expect(off[0]!.sources.map((s) => s.kind === "timesheet_line" && s.id)).toEqual([sixth.id]);
    expect(byCode(r.lines, "overtime")).toEqual([]);
  });

  it("counts the days before the cycle in the same ISO week for the sixth shift", () => {
    const before = ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"];
    const r = run(worker({ lines: [...before.map((d) => line(d, 480)), line("2026-09-20", 480)] }));
    expect(byCode(r.lines, "off_day")).toHaveLength(1);
    // The days before the cycle are never paid here.
    expect(
      r.lines.flatMap((l) => l.sources).filter((s) => s.kind === "timesheet_line"),
    ).toHaveLength(1);
  });

  it("pays a no-shift day as an off day", () => {
    const r = run(worker({ lines: [line("2026-10-04", 300, 0, false)] }));
    expect(amount(r.lines, "off_day")).toBe(600_000n);
  });

  it("pays every minute worked on a public holiday at the overtime rate on top of salary", () => {
    const r = run(worker({ lines: [line("2026-10-01", 480, 60)] }), { holidays: ["2026-10-01"] });
    expect(amount(r.lines, "overtime")).toBe(75_000n);
    expect(amount(r.lines, "public_holiday")).toBe(540n * 1_250n);
    expect(
      amount(r.lines, "basic") + amount(r.lines, "housing") + amount(r.lines, "transport"),
    ).toBe(12_000_000n);
  });

  it("keeps full pay for a rostered public holiday not worked", () => {
    const r = run(worker(), { holidays: ["2026-10-01"] });
    expect(total(r.lines)).toBe(12_000_000n);
    expect(r.days.rostered).toBe(21);
  });

  it("pays the larger rule, never both, for a public holiday on an off day", () => {
    const long = run(worker({ lines: [line("2026-10-03", 600, 0, false)] }), {
      holidays: ["2026-10-03"],
    });
    expect(amount(long.lines, "public_holiday")).toBe(600n * 1_250n);
    expect(byCode(long.lines, "off_day")).toEqual([]);
    const short = run(worker({ lines: [line("2026-10-03", 300, 0, false)] }), {
      holidays: ["2026-10-03"],
    });
    expect(amount(short.lines, "off_day")).toBe(480n * 1_250n);
    expect(byCode(short.lines, "public_holiday")).toEqual([]);
  });

  it("puts a night shift across midnight on the day it starts", () => {
    const night = line("2026-10-19", 720, 30); // 19:00 on 19 Oct to 07:30 on 20 Oct
    const next = line("2026-10-20", 720, 0); // next cycle
    const r = run(worker({ lines: [night, next] }), { holidays: ["2026-10-20"] });
    expect(amount(r.lines, "overtime")).toBe(30n * 1_250n);
    expect(byCode(r.lines, "public_holiday")).toEqual([]);
    expect(
      r.lines
        .flatMap((l) => l.sources)
        .some((s) => s.kind === "timesheet_line" && s.id === next.id),
    ).toBe(false);
  });

  it("ignores approved days with no minutes", () => {
    const r = run(worker({ lines: [line("2026-10-04", 0, 0, false)] }));
    expect(byCode(r.lines, "off_day")).toEqual([]);
  });
});

describe("leave", () => {
  const leave = (over: Partial<EarningsWorker["leave"][number]> = {}) => ({
    requestId: randomUUID(),
    typeCode: "maternity",
    counting: "calendar_days" as const,
    startDate: "2026-10-05",
    endDate: "2026-10-09",
    payPercent: 50,
    payBelowService: false,
    ...over,
  });

  it("deducts half of preset A maternity's working days from 6 months' service", () => {
    const l = leave();
    const r = run(worker({ leave: [l] }));
    const expected = roundHalfUp(12_000_000n * 5n * 50n, 21n * 100n); // 1,428,571
    expect(amount(r.lines, "leave_deduction")).toBe(-expected);
    expect(total(r.lines)).toBe(12_000_000n - expected);
    const parts = byCode(r.lines, "leave_deduction");
    expect(parts.map((p) => p.amountKobo)).toEqual(
      allocateKobo(expected, [6_000_000n, 3_600_000n, 2_400_000n]).map((k) => -k),
    );
    expect(parts[0]).toMatchObject({ pensionable: true, nhfBase: true });
    expect(parts[0]!.label).toBe("Leave paid at 50%, 5 to 9 Oct (5 days), basic");
    expect(parts[0]!.sources).toEqual([
      { kind: "leave_request", id: l.requestId, from: "2026-10-05", to: "2026-10-09" },
    ]);
    expect(r.days.leaveDeducted).toBe(5);
  });

  it("deducts preset A maternity in full below 6 months' service (unpaid)", () => {
    const r = run(worker({ leave: [leave({ payBelowService: true })] }));
    expect(amount(r.lines, "leave_deduction")).toBe(-roundHalfUp(12_000_000n * 5n, 21n));
    expect(r.trace.find((t) => t.step === "leave_deduction")!.ruleRef).toBe(
      "leave.pay_below_service",
    );
  });

  it("deducts calendar-day leave only for the days that would have been working days", () => {
    const r = run(
      worker({ leave: [leave({ startDate: "2026-10-03", endDate: "2026-10-11", payPercent: 0 })] }),
    );
    expect(r.days.leaveDeducted).toBe(5);
  });

  it("pays leave at 100% with no line", () => {
    const r = run(worker({ leave: [leave({ typeCode: "annual", payPercent: 100 })] }));
    expect(byCode(r.lines, "leave_deduction")).toEqual([]);
  });

  it("splits unpaid leave across the 19th and the 20th: each day is deducted in its own cycle, once", () => {
    const l = leave({
      typeCode: "unpaid",
      counting: "working_days",
      startDate: "2026-10-15",
      endDate: "2026-10-23",
      payPercent: 0,
    });
    const oct = run(worker({ leave: [l] }));
    expect(oct.days.leaveDeducted).toBe(3); // 15, 16 and 19 Oct
    expect(amount(oct.lines, "leave_deduction")).toBe(-roundHalfUp(12_000_000n * 3n, 21n));
    expect(byCode(oct.lines, "leave_deduction")[0]!.sources[0]).toMatchObject({
      from: "2026-10-15",
      to: "2026-10-19",
    });

    const nov = run(worker({ leave: [l] }), { period: NOV });
    expect(nov.days.leaveDeducted).toBe(4); // 20 to 23 Oct
    expect(byCode(nov.lines, "leave_deduction")[0]!.sources[0]).toMatchObject({
      from: "2026-10-20",
      to: "2026-10-23",
    });
    expect(amount(nov.lines, "leave_deduction")).toBe(
      -roundHalfUp(12_000_000n * 4n, BigInt(nov.days.rostered)),
    );
  });

  it("pays 0 for a cycle entirely on unpaid leave", () => {
    const r = run(
      worker({
        payRates: [monthly({ otherAllowances: 777_777n })],
        leave: [leave({ startDate: "2026-09-20", endDate: "2026-10-19", payPercent: 0 })],
      }),
    );
    expect(total(r.lines)).toBe(0n);
  });

  it("flags approved leave without its pay record and deducts nothing", () => {
    const r = run(worker({ leave: [leave({ payPercent: null, payBelowService: null })] }));
    expect(r.flags).toContain("leave_pay_missing");
    expect(byCode(r.lines, "leave_deduction")).toEqual([]);
  });

  it("gives daily and hourly workers no leave deduction", () => {
    const daily = {
      ...monthly(),
      payType: "daily" as const,
      basic: 0n,
      housing: 0n,
      transport: 0n,
      dailyRate: 800_000n,
    };
    const r = run(
      worker({ employmentType: "daily", payRates: [daily], leave: [leave({ payPercent: 0 })] }),
    );
    expect(r.lines).toEqual([]);
  });
});

describe("daily and hourly workers", () => {
  const daily = (): PayRateInput => ({
    ...monthly(),
    payType: "daily",
    basic: 0n,
    housing: 0n,
    transport: 0n,
    dailyRate: 800_000n,
  });
  const hourly = (): PayRateInput => ({
    ...monthly(),
    payType: "hourly",
    basic: 0n,
    housing: 0n,
    transport: 0n,
    hourlyRate: 100_000n,
  });

  it("pays a daily worker once per date, with overtime at daily rate ÷ shift hours", () => {
    const r = run(
      worker({
        employmentType: "daily",
        payRates: [daily()],
        lines: [line("2026-10-01", 240), line("2026-10-01", 240, 60), line("2026-10-02", 480)],
      }),
    );
    expect(amount(r.lines, "daily_pay")).toBe(1_600_000n);
    expect(byCode(r.lines, "daily_pay")[0]!.label).toBe("Daily pay, 2 days at ₦8,000.00");
    expect(byCode(r.lines, "daily_pay")[0]!.sources).toHaveLength(3);
    expect(amount(r.lines, "overtime")).toBe(100_000n);
    expect(byCode(r.lines, "basic")).toEqual([]);
    expect(byCode(r.lines, "off_day")).toEqual([]);
  });

  it("does not count a daily worker's date with overtime only", () => {
    const r = run(
      worker({ employmentType: "daily", payRates: [daily()], lines: [line("2026-10-01", 0, 60)] }),
    );
    expect(byCode(r.lines, "daily_pay")).toEqual([]);
    expect(amount(r.lines, "overtime")).toBe(100_000n);
  });

  it("pays an hourly worker for approved minutes", () => {
    const r = run(
      worker({
        payRates: [hourly()],
        lines: [line("2026-10-01", 480, 30), line("2026-10-04", 125, 0, false)],
      }),
    );
    expect(amount(r.lines, "hourly_pay")).toBe(roundHalfUp(605n * 100_000n, 60n));
    expect(amount(r.lines, "overtime")).toBe(50_000n);
    expect(byCode(r.lines, "off_day")).toEqual([]);
  });

  it("adds the public-holiday premium for a daily worker who works the holiday", () => {
    const r = run(
      worker({ employmentType: "daily", payRates: [daily()], lines: [line("2026-10-01", 480)] }),
      { holidays: ["2026-10-01"] },
    );
    expect(amount(r.lines, "daily_pay")).toBe(800_000n);
    expect(amount(r.lines, "public_holiday")).toBe(800_000n);
  });
});

describe("arrears", () => {
  const arrear = (
    workDate: string,
    worked: number,
    ot: number,
    hasShift = true,
    weekShiftDays = 5,
  ) => ({
    ...line(workDate, worked, ot, hasShift),
    periodStart: "2026-08-20",
    weekShiftDays,
  });

  it("pays a day approved after its cycle was posted as arrears at that day's rate, once", () => {
    const old = monthly({ effectiveTo: "2026-09-19", basic: 5_000_000n });
    const now = monthly({ effectiveFrom: "2026-09-20" });
    const a = arrear("2026-09-10", 480, 30);
    const r = run(worker({ payRates: [old, now], arrears: [a] }));
    const arrears = byCode(r.lines, "arrears");
    expect(arrears).toHaveLength(1);
    // Overtime only (the salary was paid), at the old rate: ₦110,000 ÷ 9,600 minutes x 30.
    expect(arrears[0]!.amountKobo).toBe(roundHalfUp(11_000_000n * 30n, 9_600n));
    expect(arrears[0]!.label).toBe("Arrears, 20 Aug to 19 Sep, approved after posting (1 day)");
    expect(arrears[0]!.sources).toEqual([
      { kind: "timesheet_line", id: a.id, workDate: "2026-09-10" },
    ]);
    expect(total(r.lines)).toBe(12_000_000n + arrears[0]!.amountKobo);
  });

  it("prices an arrears off day (a sixth shift in its week) as an 8-hour shift", () => {
    const r = run(worker({ arrears: [arrear("2026-09-12", 480, 0, true, 6)] }));
    expect(amount(r.lines, "arrears")).toBe(600_000n);
  });

  it("pays a daily worker's arrears day with its daily pay", () => {
    const daily = {
      ...monthly(),
      payType: "daily" as const,
      basic: 0n,
      housing: 0n,
      transport: 0n,
      dailyRate: 800_000n,
    };
    const r = run(
      worker({
        employmentType: "daily",
        payRates: [daily],
        arrears: [arrear("2026-09-10", 480, 0)],
      }),
    );
    expect(amount(r.lines, "arrears")).toBe(800_000n);
  });
});

describe("flags and trace", () => {
  it("flags no-show days and open timesheet days without deducting", () => {
    const r = run(worker({ noShowDates: ["2026-10-07", "2026-10-20"], openLineCount: 2 }));
    expect(r.flags).toEqual(["no_show_days", "open_timesheet_days"]);
    expect(r.days.noShowDates).toEqual(["2026-10-07"]);
    expect(total(r.lines)).toBe(12_000_000n);
  });

  it("writes a trace with kobo as strings and no names", () => {
    const r = run(worker({ startDate: "2026-10-01", lines: [line("2026-10-01", 480, 20)] }));
    expect(r.trace.map((t) => t.step)).toEqual(["rostered_days", "salary", "overtime"]);
    const salary = r.trace[1]!;
    expect(salary.inputs).toMatchObject({
      monthly_gross_kobo: "12000000",
      employed_rostered_days: 13,
      rostered_days: 21,
    });
    expect(salary.valueKobo).toBe(7_428_571n);
    for (const step of r.trace) {
      for (const value of Object.values(step.inputs))
        expect(typeof value === "string" || Number.isInteger(value)).toBe(true);
    }
  });

  it("never rounds a line twice: each line equals its trace value", () => {
    const r = run(
      worker({
        startDate: "2026-09-23",
        lines: [line("2026-10-01", 480, 17), line("2026-10-04", 61, 0, false)],
      }),
      { holidays: ["2026-10-01"] },
    );
    for (const step of r.trace.filter((t) =>
      ["overtime", "off_day", "public_holiday"].includes(t.step),
    )) {
      const lines = byCode(r.lines, step.step as EarningLine["code"]);
      expect(total(lines)).toBe(step.valueKobo);
    }
  });
});

describe("parsePayrollInputs", () => {
  it("turns kobo strings into bigint and refuses floats", () => {
    const rate = {
      id: randomUUID(),
      pay_type: "monthly",
      currency: "NGN",
      basic_kobo: "6000000",
      housing_kobo: "3600000",
      transport_kobo: "2400000",
      other_allowances_kobo: "0",
      daily_rate_kobo: null,
      hourly_rate_kobo: null,
      effective_from: "2025-01-01",
      effective_to: null,
    };
    const raw = {
      version: 1,
      organisation: {
        pay_cycle_start_day: 20,
        pay_day: 25,
        standard_shift_minutes: 480,
        hourly_rate_divisor_days: 20,
        work_days_per_week: 5,
        default_work_days: MON_FRI,
        shifts_enabled: true,
      },
      period: { start: OCT.start, end: OCT.end, pay_date: "2026-10-25" },
      holidays: ["2026-10-01"],
      workers: [
        {
          worker_id: randomUUID(),
          employment_type: "permanent",
          start_date: "2025-01-06",
          end_date: null,
          status: "active",
          usual_work_days: null,
          statutory: {
            tax_state: "Lagos",
            pfa_name: "Stanbic IBTC Pension",
            nhf_opt_in: false,
            annual_rent_declared_kobo: "36000000",
            has_tin: true,
            has_rsa_pin: true,
          },
          pay_rates: [rate],
          shifts: [{ date: "2026-10-01", on_leave: false }],
          last_rostered: "2026-10-01",
          lines: [],
          arrears: [],
          no_show_dates: [],
          open_line_count: 0,
          leave: [],
        },
      ],
    };
    const parsed = parsePayrollInputs(raw);
    expect(parsed.workers[0]!.payRates[0]!.basic).toBe(6_000_000n);
    expect(parsed.workers[0]!.statutory.annualRentKobo).toBe(36_000_000n);
    expect(parsed.period.payDate).toBe("2026-10-25");
    const bad = structuredClone(raw);
    bad.workers[0]!.pay_rates[0]!.basic_kobo = "6000000.5";
    expect(() => parsePayrollInputs(bad)).toThrow();
  });
});
