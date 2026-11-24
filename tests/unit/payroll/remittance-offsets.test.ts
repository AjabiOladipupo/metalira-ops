/**
 * Slice 5.7c: refunds and offsets of a payment made against a remittance a reversal voided, in
 * kobo (src/lib/payroll/remittance-offsets.ts). October's pension (₦156,600) was paid, then
 * October was reversed; November owes the same PFA ₦160,000.
 */
import { describe, expect, it } from "vitest";

import { remittanceOutstanding, remittanceStatus } from "@/lib/payroll/statutory";
import {
  dueAfterOffsets,
  maxOffset,
  resolutionRefusal,
  resolvePayment,
} from "@/lib/payroll/remittance-offsets";

const PAID = 15_660_000n;
const NOV = 16_000_000n;

describe("resolving a payment on a voided remittance", () => {
  it("splits it into refunded, offset and unresolved, to the kobo", () => {
    const r = resolvePayment(PAID, [
      { kind: "refund", amountKobo: 5_000_000n },
      { kind: "offset", amountKobo: 10_000_001n },
    ]);
    expect(r).toEqual({
      paidKobo: PAID,
      refundedKobo: 5_000_000n,
      offsetKobo: 10_000_001n,
      unresolvedKobo: 659_999n,
    });
    expect(r.refundedKobo + r.offsetKobo + r.unresolvedKobo).toBe(PAID);
  });

  it("is fully resolved by a whole offset, and never goes below ₦0 unresolved", () => {
    expect(resolvePayment(PAID, [{ kind: "offset", amountKobo: PAID }]).unresolvedKobo).toBe(0n);
    expect(resolvePayment(PAID, [{ kind: "refund", amountKobo: PAID + 1n }]).unresolvedKobo).toBe(
      0n,
    );
  });
});

describe("offsets against the next remittance", () => {
  it("leaves November owing ₦160,000 less the offset, so the right payment shows as paid", () => {
    const due = dueAfterOffsets(NOV, PAID);
    expect(due).toBe(340_000n);
    const owed = { dueDate: "2026-12-02", amountKobo: due, paidKobo: null };
    expect(remittanceOutstanding(owed)).toBe(340_000n);
    expect(remittanceStatus({ ...owed, paidKobo: 340_000n }, "2026-11-30")).toBe("paid");
    expect(remittanceStatus({ ...owed, paidKobo: NOV }, "2026-11-30")).toBe("overpaid");
    expect(remittanceOutstanding({ ...owed, paidKobo: 300_000n })).toBe(40_000n);
  });

  it("caps an offset by what the payment has left and what the target still owes", () => {
    const source = resolvePayment(PAID, []);
    expect(maxOffset(source, { amountKobo: NOV, offsetsInKobo: 0n, paidKobo: null })).toBe(PAID);
    expect(maxOffset(source, { amountKobo: 10_000_000n, offsetsInKobo: 0n, paidKobo: null })).toBe(
      10_000_000n,
    );
    expect(
      maxOffset(source, { amountKobo: NOV, offsetsInKobo: 6_000_000n, paidKobo: 9_000_000n }),
    ).toBe(1_000_000n);
    expect(maxOffset(source, { amountKobo: NOV, offsetsInKobo: 0n, paidKobo: NOV })).toBe(0n);
  });

  it("refuses an amount above what's unresolved or above the target's room", () => {
    const source = resolvePayment(PAID, [{ kind: "refund", amountKobo: 15_000_000n }]);
    expect(resolutionRefusal("refund", 660_000n, source)).toBeNull();
    expect(resolutionRefusal("refund", 660_001n, source)).toBe(
      "That is more than the payment still to resolve.",
    );
    expect(resolutionRefusal("offset", 600_000n, source, 500_000n)).toBe(
      "That is more than the later remittance still owes.",
    );
    expect(resolutionRefusal("offset", 0n, source)).toBe("Enter an amount above ₦0.");
  });
});
