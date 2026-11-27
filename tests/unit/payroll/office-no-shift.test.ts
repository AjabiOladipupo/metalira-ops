/**
 * Slice 6.11 (money review H1): a monthly worker's no-shift clock-in on a working day (Head
 * office staff every weekday) is covered by salary. The cycle that covers it records the line as
 * a source of the salary line, so the arrears read (which leaves out lines a standing payslip
 * already sources) never brings it back as off-day work the next month.
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { sumKobo } from "@/lib/money";
import type { EarningLine } from "@/lib/payroll/earning-lines";
import {
  computeEarnings,
  POLICY_DEFAULTS,
  type EarningsWorker,
  type PayPolicy,
} from "@/lib/payroll/earnings";
import type { PayRateInput } from "@/lib/payroll/inputs";

const OCT = { start: "2026-09-20", end: "2026-10-19" };
const NOV = { start: "2026-10-20", end: "2026-11-19" };
const MON_FRI = [1, 2, 3, 4, 5];
const POLICY: PayPolicy = {
  standardShiftMinutes: 480,
  hourlyRateDivisorDays: 20,
  workDaysPerWeek: 5,
  ...POLICY_DEFAULTS,
};

const rate: PayRateInput = {
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
};

function worker(over: Partial<EarningsWorker> = {}): EarningsWorker {
  return {
    workerId: randomUUID(),
    employmentType: "permanent",
    startDate: "2025-01-06",
    endDate: null,
    usualWorkDays: null,
    payRates: [rate],
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

const run = (w: EarningsWorker, period = OCT) =>
  computeEarnings({ period, holidays: [], defaultWorkDays: MON_FRI, worker: w }, POLICY);
const total = (lines: EarningLine[]) => sumKobo(lines.map((l) => l.amountKobo));
const timesheetSources = (lines: EarningLine[]) =>
  lines.flatMap((l) => l.sources.flatMap((s) => (s.kind === "timesheet_line" ? [s.id] : [])));

describe("no-shift weekday clock-ins of a monthly worker", () => {
  // Thu 1 Oct to Wed 7 Oct: five weekdays at Head office, no shifts.
  const weekdays = ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"];
  const lines = weekdays.map((d) => ({
    id: randomUUID(),
    workDate: d,
    workedMinutes: 480,
    otMinutes: 0,
    hasShift: false,
    projectId: null,
  }));

  it("pays the salary only, and records each covered day as a source of the salary line", () => {
    const r = run(worker({ lines }));
    expect(total(r.lines)).toBe(12_000_000n);
    expect(r.lines.some((l) => l.code === "off_day" || l.code === "arrears")).toBe(false);
    const basic = r.lines.find((l) => l.code === "basic")!;
    expect(basic.sources[0]).toMatchObject({ kind: "pay_rate", id: rate.id });
    expect(timesheetSources([basic]).sort()).toEqual(lines.map((l) => l.id).sort());
    // Each day once, on one line.
    expect(timesheetSources(r.lines)).toHaveLength(lines.length);
  });

  it("brings nothing back the next month: the arrears read leaves sourced lines out, so ₦0 arrears", () => {
    const october = run(worker({ lines }));
    const sourced = new Set(timesheetSources(october.lines));
    // What the arrears read would return: approved lines of the posted cycle with no source.
    const arrears = lines
      .filter((l) => !sourced.has(l.id))
      .map((l) => ({
        ...l,
        periodStart: OCT.start,
        weekShiftDays: 0,
        weekShiftRank: 0,
        weekOffDaysPaid: 0,
      }));
    expect(arrears).toEqual([]);
    const november = run(worker({ arrears }), NOV);
    expect(november.lines.filter((l) => l.code === "arrears")).toEqual([]);
    expect(total(november.lines)).toBe(12_000_000n);
  });

  it("still pays overtime on such a day, sourced by the overtime line", () => {
    const withOt = [{ ...lines[0]!, otMinutes: 60 }];
    const r = run(worker({ lines: withOt }));
    const ot = r.lines.find((l) => l.code === "overtime")!;
    expect(timesheetSources([ot])).toEqual([withOt[0]!.id]);
    expect(timesheetSources(r.lines)).toEqual([withOt[0]!.id]);
  });

  it("leaves a Saturday clock-in as off-day work, as before", () => {
    const sat = [{ ...lines[0]!, id: randomUUID(), workDate: "2026-10-03" }];
    const r = run(worker({ lines: sat }));
    expect(r.lines.some((l) => l.code === "off_day")).toBe(true);
    expect(timesheetSources(r.lines.filter((l) => l.code === "basic"))).toEqual([]);
  });
});
