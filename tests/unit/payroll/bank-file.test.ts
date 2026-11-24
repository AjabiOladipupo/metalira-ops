/**
 * Slice 5.4: the bank file's bytes (docs/PHASE_5.md 5.4): the generic CSV against its fixture,
 * formula-injection escaping, kobo to naira with exactly 2 decimals by integer maths, the total
 * equal to the sum of the items, and who is paid, left out or refused (decision 11).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { sumKobo, type Kobo } from "@/lib/money";
import {
  decidePayout,
  nameList,
  planRefusal,
  summarisePlan,
  type PayoutPlanRow,
} from "@/lib/payroll/payout";
import { bankFormat, BANK_FORMAT_IDS, salaryNarration } from "@/server/payroll/bank-formats";
import type { BankFileItem } from "@/server/payroll/bank-formats";
import { csvCell, nairaAmount } from "@/server/payroll/bank-formats/csv";
import { genericCsv } from "@/server/payroll/bank-formats/generic-csv";

const FIXTURE = fileURLToPath(
  new URL("../../../fixtures/bank-files/generic-csv-october-2026.csv", import.meta.url),
);

const ITEMS: BankFileItem[] = [
  {
    beneficiaryName: "IBRAHIM MUSA",
    accountNumber: "0123456789",
    bankCode: "058",
    bankName: "GTBank",
    amountKobo: 10_474_000n,
    narration: salaryNarration("2026-10-19", "MLS-0001"),
  },
  {
    beneficiaryName: "-OKAFOR, CHIDINMA",
    accountNumber: "1234567890",
    bankCode: "044",
    bankName: "Access Bank",
    amountKobo: 9_521_050n,
    narration: salaryNarration("2026-10-19", "MLS-0002"),
  },
  {
    beneficiaryName: "=CMD|' /C CALC'!A0",
    accountNumber: "2345678901",
    bankCode: "999992",
    bankName: 'OPay "Digital"',
    amountKobo: 5n,
    narration: salaryNarration("2026-10-19", "MLS-0003"),
  },
];

describe("generic CSV", () => {
  it("renders the fixture's bytes exactly (CRLF, no byte-order mark)", () => {
    const expected = readFileSync(FIXTURE);
    const bytes = genericCsv.render(ITEMS);
    expect(Buffer.from(bytes).equals(expected)).toBe(true);
    expect(bytes[0]).toBe("B".charCodeAt(0));
  });

  it("is the registered format", () => {
    expect(BANK_FORMAT_IDS).toEqual(["generic-csv"]);
    expect(bankFormat("generic-csv")).toBe(genericCsv);
    expect(bankFormat("nibss")).toBeNull();
    for (const id of BANK_FORMAT_IDS) expect(id).toMatch(/^[a-z][a-z0-9-]{1,39}$/);
  });

  it("writes the narration from the period end's month and the staff ID", () => {
    expect(salaryNarration("2026-10-19", "MLS-0001")).toBe("Salary Oct 2026 MLS-0001");
    expect(salaryNarration("2027-01-19", "A7")).toBe("Salary Jan 2027 A7");
  });

  it("totals: the amounts in the file sum to the items' kobo", () => {
    const text = new TextDecoder().decode(genericCsv.render(ITEMS));
    const amounts = text
      .trim()
      .split("\r\n")
      .slice(1)
      .map((line) => /,(\d+)\.(\d{2}),Salary/.exec(line))
      .map((m) => BigInt(m![1]!) * 100n + BigInt(m![2]!));
    expect(sumKobo(amounts)).toBe(sumKobo(ITEMS.map((i) => i.amountKobo)));
    expect(amounts).toHaveLength(ITEMS.length);
  });
});

describe("formula-injection escaping", () => {
  it.each([
    ["=SUM(A1)", "'=SUM(A1)"],
    ["+2348012345678", "'+2348012345678"],
    ["-10", "'-10"],
    ["@SUM(1)", "'@SUM(1)"],
    ["\tTAB", "'\tTAB"],
    ["\rCR", '"\'\rCR"'],
  ])("prefixes %j", (input, output) => {
    expect(csvCell(input)).toBe(output);
  });

  it("leaves ordinary cells alone and quotes commas, quotes and line breaks", () => {
    expect(csvCell("IBRAHIM MUSA")).toBe("IBRAHIM MUSA");
    expect(csvCell("0123456789")).toBe("0123456789");
    expect(csvCell("a=b")).toBe("a=b");
    expect(csvCell("Okafor, Chidinma")).toBe('"Okafor, Chidinma"');
    expect(csvCell('OPay "Digital"')).toBe('"OPay ""Digital"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
  });
});

describe("kobo to naira", () => {
  it.each<[Kobo, string]>([
    [1n, "0.01"],
    [5n, "0.05"],
    [10n, "0.10"],
    [99n, "0.99"],
    [100n, "1.00"],
    [10_474_000n, "104740.00"],
    [9_521_050n, "95210.50"],
    [1_841_260_000n, "18412600.00"],
    // Beyond Number.MAX_SAFE_INTEGER: integer maths keeps every digit.
    [900_719_925_474_099_312n, "9007199254740993.12"],
  ])("%s kobo is %s", (kobo, naira) => {
    expect(nairaAmount(kobo)).toBe(naira);
  });

  it("refuses ₦0, negative amounts and numbers", () => {
    expect(() => nairaAmount(0n)).toThrow(RangeError);
    expect(() => nairaAmount(-1n)).toThrow(RangeError);
    expect(() => nairaAmount(100 as unknown as bigint)).toThrow(RangeError);
  });
});

const row = (over: Partial<PayoutPlanRow> = {}): PayoutPlanRow => ({
  payslipId: "p1",
  workerId: "w1",
  workerName: "Musa Ibrahim",
  staffId: "MLS-0001",
  netKobo: 10_474_000n,
  bankName: "GTBank",
  bankCode: "058",
  accountName: "IBRAHIM MUSA",
  bankAccountLast4: "6789",
  bankDetailChangeId: null,
  onFile: true,
  inHold: false,
  acknowledgedCode: null,
  ...over,
});

describe("who is paid (decision 11)", () => {
  it("pays a worker with details and a bank code", () => {
    expect(decidePayout(row())).toEqual({ kind: "pay" });
  });

  it("leaves out net ₦0 whatever the details", () => {
    expect(decidePayout(row({ netKobo: 0n, onFile: false }))).toEqual({
      kind: "left_out",
      reason: "nothing_to_pay",
    });
  });

  it("leaves out missing details only when HR acknowledged them; refuses otherwise", () => {
    const missing = { onFile: false, bankName: null, accountName: null, bankAccountLast4: null };
    expect(decidePayout(row({ ...missing, acknowledgedCode: "bank_missing" }))).toEqual({
      kind: "left_out",
      reason: "no_bank_details",
    });
    expect(decidePayout(row(missing))).toEqual({ kind: "refuse", reason: "no_details" });
  });

  it("leaves out a change in its hold when acknowledged; else pays the account in force", () => {
    expect(decidePayout(row({ inHold: true, acknowledgedCode: "bank_in_hold" }))).toEqual({
      kind: "left_out",
      reason: "bank_change_in_hold",
    });
    expect(decidePayout(row({ inHold: true }))).toEqual({ kind: "pay" });
  });

  it("refuses a missing bank code", () => {
    expect(decidePayout(row({ bankCode: null }))).toEqual({ kind: "refuse", reason: "no_code" });
  });

  it("summarises the plan and refuses by name", () => {
    const plan = [
      row(),
      row({ payslipId: "p2", workerName: "Grace Edet", bankCode: null }),
      row({ payslipId: "p3", workerName: "Ada Obi", netKobo: 0n }),
    ];
    const s = summarisePlan(plan);
    expect(s.paid.map((r) => r.payslipId)).toEqual(["p1"]);
    expect(s.leftOut.map((l) => l.reason)).toEqual(["nothing_to_pay"]);
    expect(s.totalKobo).toBe(10_474_000n);
    expect(planRefusal(s)).toBe(
      "No bank code for Grace Edet. Check their bank details on their page, then make the file again.",
    );
    expect(planRefusal(summarisePlan([row()]))).toBeNull();
    expect(planRefusal(summarisePlan([row({ netKobo: 0n })]))).toBe(
      "Nobody in this run can be paid by bank file.",
    );
  });

  it("lists at most five names", () => {
    expect(nameList(["B", "A"])).toBe("A, B");
    expect(nameList(["F", "E", "D", "C", "B", "A", "G"])).toBe("A, B, C, D, E and 2 more");
  });
});
