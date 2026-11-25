/**
 * Slice 5.7a (money review M2): a reversed run's voided remittances are counted apart and left
 * out of every other count and of the amount still to pay.
 */
import { describe, expect, it } from "vitest";

import { summariseRemittances } from "@/server/payroll/remittance-data";

type Row = Parameters<typeof summariseRemittances>[0][number];

const row = (over: Partial<Row>): Row => ({
  status: "due",
  overdue: false,
  outstandingKobo: 0n,
  dueDate: null,
  ...over,
});

describe("summariseRemittances", () => {
  it("leaves voided remittances out of due, paid, no due date and the total", () => {
    const summary = summariseRemittances([
      row({ status: "due", outstandingKobo: 15_660_000n, dueDate: "2026-11-02" }),
      row({ status: "paid" }),
      row({ status: "no_due_date", outstandingKobo: 870_000n }),
      // A reversed run's: one unpaid, one paid before the reversal (refund or offset needed).
      row({ status: "voided", outstandingKobo: 0n, dueDate: "2026-10-01" }),
      row({ status: "voided", outstandingKobo: 0n }),
    ]);
    expect(summary).toEqual({
      remittances: 3,
      paid: 1,
      partPaid: 0,
      overpaid: 0,
      due: 1,
      overdue: 0,
      pastPenalty: 0,
      provisional: 0,
      noDueDate: 1,
      voided: 2,
      outstandingKobo: "16530000",
      nextDueDate: "2026-11-02",
    });
  });

  it("counts PAYE past its penalty date and provisional due dates, voided ones left out (slice 5.9b)", () => {
    const summary = summariseRemittances([
      row({
        status: "overdue",
        overdue: true,
        pastPenalty: true,
        outstandingKobo: 100_000n,
        dueDate: "2026-11-10",
        deadline: { provisional: true },
      }),
      row({
        status: "due",
        outstandingKobo: 200_000n,
        dueDate: "2026-12-03",
        deadline: { provisional: false },
      }),
      // Paid: nothing owed, so not counted as provisional.
      row({ status: "paid", deadline: { provisional: true } }),
      row({ status: "voided", pastPenalty: false, deadline: { provisional: true } }),
    ]);
    expect(summary).toMatchObject({ overdue: 1, pastPenalty: 1, provisional: 1, voided: 1 });
  });

  it("gives zeros when every remittance is voided", () => {
    const summary = summariseRemittances([row({ status: "voided" })]);
    expect(summary.remittances).toBe(0);
    expect(summary.voided).toBe(1);
    expect(summary.outstandingKobo).toBe("0");
    expect(summary.nextDueDate).toBeNull();
  });
});
