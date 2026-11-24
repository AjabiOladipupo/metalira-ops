/**
 * Slice 5.7c: who a supplementary bank file pays (src/lib/payroll/supplement.ts). Workers a
 * released run's file left out are outstanding; those whose details are now in force (complete,
 * with a bank code, no change waiting) are ready; the rest wait, with the reason.
 */
import { describe, expect, it } from "vitest";

import {
  summariseSupplement,
  supplementItemsPayloadShape,
  supplementRefusal,
  waitingReason,
  type SupplementRow,
} from "@/lib/payroll/supplement";

function row(over: Partial<SupplementRow> = {}): SupplementRow {
  return {
    payslipId: crypto.randomUUID(),
    workerId: crypto.randomUUID(),
    workerName: "Musa Ibrahim",
    staffId: "MLS-0001",
    netKobo: 10_474_000n,
    bankName: "GTBank",
    bankCode: "058",
    accountName: "MUSA IBRAHIM",
    bankAccountLast4: "7712",
    bankDetailChangeId: null,
    onFile: true,
    inHold: false,
    acknowledgedCode: null,
    originalItemId: crypto.randomUUID(),
    leftOutReason: "no_bank_details",
    ready: true,
    ...over,
  };
}

describe("supplementary file: who is ready", () => {
  it("pays a worker whose details are now in force, their net pay", () => {
    const s = summariseSupplement([row()]);
    expect(s.ready).toHaveLength(1);
    expect(s.readyKobo).toBe(10_474_000n);
    expect(s.outstandingKobo).toBe(10_474_000n);
    expect(supplementRefusal(s)).toBeNull();
  });

  it("keeps waiting a worker with no details, a change in its hold, or no bank code", () => {
    const none = row({ onFile: false, bankName: null, accountName: null, bankAccountLast4: null });
    const hold = row({ inHold: true, ready: false });
    const code = row({ bankCode: null, ready: false });
    expect(waitingReason(none)).toBe("no_bank_details");
    expect(waitingReason(hold)).toBe("bank_change_in_hold");
    expect(waitingReason(code)).toBe("no_bank_code");
    const s = summariseSupplement([none, hold, code, row({ netKobo: 500_000n })]);
    expect(s.ready).toHaveLength(1);
    expect(s.readyKobo).toBe(500_000n);
    expect(s.waiting.map((w) => w.reason)).toEqual([
      "no_bank_details",
      "bank_change_in_hold",
      "no_bank_code",
    ]);
    expect(s.outstandingKobo).toBe(10_474_000n * 3n + 500_000n);
  });

  it("waits when the database says not ready, whatever the row looks like (the safer side)", () => {
    const s = summariseSupplement([row({ ready: false })]);
    expect(s.ready).toEqual([]);
    expect(s.waiting).toHaveLength(1);
  });

  it("refuses a file nobody can be paid by", () => {
    expect(supplementRefusal(summariseSupplement([]))).toBe("Nobody is outstanding on this run.");
    expect(supplementRefusal(summariseSupplement([row({ ready: false, inHold: true })]))).toMatch(
      /^Nobody left out of this run's bank file has bank details in force yet/,
    );
  });

  it("sends positions and details, never an account number", () => {
    const payload = supplementItemsPayloadShape([row(), row({ netKobo: 1n })]);
    expect(payload.map((p) => p.position)).toEqual([1, 2]);
    expect(payload[1]!.amount_kobo).toBe("1");
    expect(JSON.stringify(payload)).not.toMatch(/\d{10}/);
    expect(Object.keys(payload[0]!).sort()).toEqual([
      "account_name",
      "amount_kobo",
      "bank_account_last4",
      "bank_code",
      "bank_detail_change_id",
      "bank_name",
      "payslip_id",
      "position",
    ]);
  });
});
