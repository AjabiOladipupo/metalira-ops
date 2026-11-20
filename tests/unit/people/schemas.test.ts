import { describe, expect, it } from "vitest";

import {
  addPayRateSchema,
  createWorkerSchema,
  endEmploymentSchema,
  nairaSchema,
  nigerianMobileSchema,
  toPayRateRecord,
  updateWorkerSchema,
} from "@/server/people/schemas";

const WORKER = "b0000000-0000-4000-8000-000000000002";
const OTHER = "b0000000-0000-4000-8000-000000000003";

const base = {
  firstName: "Musa",
  lastName: "Ibrahim",
  employmentType: "permanent",
  startDate: "2024-03-03",
};

function issues(result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}) {
  return Object.fromEntries(
    (result.error?.issues ?? []).map((i) => [String(i.path[0]), i.message]),
  );
}

describe("naira amounts become exact kobo", () => {
  const amount = nairaSchema("Basic monthly");

  it.each([
    ["105000", 10_500_000n],
    ["105,000", 10_500_000n],
    ["105000.50", 10_500_050n],
    ["105000.5", 10_500_050n],
    ["₦642,312.50", 64_231_250n],
    ["0", 0n],
    ["9,999,999,999,999.99", 999_999_999_999_999n],
  ])("%s gives %s kobo", (input, kobo) => {
    expect(amount.safeParse(input)).toEqual({ success: true, data: kobo });
  });

  it.each(["-5", "1e5", "105000.505", "10,50", "abc", " ", "0x10"])("refuses %j", (input) => {
    expect(amount.safeParse(input).success).toBe(false);
  });

  it("refuses JavaScript numbers, which may already have lost kobo", () => {
    expect(amount.safeParse(105000.5).success).toBe(false);
    expect(amount.safeParse(105000).success).toBe(false);
  });

  it("accepts kobo as a bigint from code, within the database cap", () => {
    expect(amount.safeParse(10_500_000n)).toEqual({ success: true, data: 10_500_000n });
    expect(amount.safeParse(-1n).success).toBe(false);
    expect(amount.safeParse(1_000_000_000_000_001n).success).toBe(false);
  });
});

describe("phone numbers", () => {
  it.each([
    ["0803 123 4567", "08031234567"],
    ["+234 803 123 4567", "08031234567"],
    ["2348031234567", "08031234567"],
    ["8031234567", "08031234567"],
    ["(0703) 123-4567", "07031234567"],
  ])("%s is stored as %s", (input, stored) => {
    expect(nigerianMobileSchema.parse(input)).toBe(stored);
  });

  it.each(["0123456789", "080312345", "01 234 5678", "06031234567"])("refuses %s", (input) => {
    expect(nigerianMobileSchema.safeParse(input).success).toBe(false);
  });
});

describe("createWorkerSchema", () => {
  it("normalises blanks to null and defaults the flags", () => {
    const data = createWorkerSchema.parse({
      ...base,
      staffId: " ",
      email: "",
      phone: "08031234567",
    });
    expect(data).toMatchObject({
      staffId: null,
      email: null,
      phone: "08031234567",
      nhfOptIn: false,
      supervisorClockIn: false,
      payType: null,
      basic: null,
    });
  });

  it("parses monthly pay to kobo and checks the amounts belong to the pay type", () => {
    const data = createWorkerSchema.parse({
      ...base,
      payType: "monthly",
      basic: "105,000",
      housing: "63000",
      transport: "42000.50",
    });
    expect(data).toMatchObject({ basic: 10_500_000n, housing: 6_300_000n, transport: 4_200_050n });

    expect(issues(createWorkerSchema.safeParse({ ...base, payType: "monthly" }))).toEqual({
      basic: "Monthly pay needs a basic amount",
    });
    expect(
      issues(
        createWorkerSchema.safeParse({
          ...base,
          payType: "monthly",
          basic: "1",
          dailyRate: "8000",
        }),
      ),
    ).toEqual({ dailyRate: "Leave this blank for monthly pay" });
    expect(
      issues(
        createWorkerSchema.safeParse({ ...base, payType: "daily", dailyRate: "8000", basic: "5" }),
      ),
    ).toEqual({ basic: "Leave this blank for daily pay" });
    expect(issues(createWorkerSchema.safeParse({ ...base, payType: "hourly" }))).toEqual({
      hourlyRate: "Hourly pay needs an hourly rate",
    });
    expect(issues(createWorkerSchema.safeParse({ ...base, basic: "105000" }))).toEqual({
      payType: "Choose the pay type",
    });
    expect(
      issues(
        createWorkerSchema.safeParse({
          ...base,
          payType: "daily",
          dailyRate: "8000",
          payEffectiveFrom: "2024-01-01",
        }),
      ),
    ).toEqual({ payEffectiveFrom: "Pay can't start before the start date" });
  });

  it("takes the bank and number together, with the bank's lookup; NUBAN 10 digits", () => {
    const LOOKUP = "d0000000-0000-4000-8000-0000000000aa";
    expect(issues(createWorkerSchema.safeParse({ ...base, bankCode: "058" }))).toEqual({
      bankAccountNumber: "Choose the bank and enter the account number together",
    });
    expect(
      issues(
        createWorkerSchema.safeParse({ ...base, bankCode: "058", bankAccountNumber: "0123457712" }),
      ),
    ).toEqual({ bankAccountNumber: "Wait for the bank to give the account name" });
    expect(
      issues(
        createWorkerSchema.safeParse({
          ...base,
          bankCode: "058",
          bankLookupId: LOOKUP,
          bankAccountNumber: "012345678",
        }),
      ),
    ).toEqual({ bankAccountNumber: "Bank account numbers are 10 digits" });
    expect(
      issues(
        createWorkerSchema.safeParse({
          ...base,
          bankCode: "12345",
          bankLookupId: LOOKUP,
          bankAccountNumber: "0123457712",
        }),
      ),
    ).toEqual({ bankCode: "Choose a bank from the list" });
    const ok = createWorkerSchema.parse({
      ...base,
      bankCode: "058",
      bankLookupId: LOOKUP,
      bankAccountNumber: "0123 457 712",
      // An account name typed into the form is ignored: the bank's name comes from the lookup.
      accountName: "Typed by hand",
    });
    expect(ok.bankAccountNumber).toBe("0123457712");
    expect(ok).not.toHaveProperty("accountName");
  });

  it("checks NIN format, RSA PIN shape and plain-text names", () => {
    expect(issues(createWorkerSchema.safeParse({ ...base, nin: "1234567890" }))).toEqual({
      nin: "A NIN is 11 digits",
    });
    expect(createWorkerSchema.parse({ ...base, nin: "123 4567 8901" }).nin).toBe("12345678901");
    expect(createWorkerSchema.parse({ ...base, rsaPin: "pen 1000 1234 4421" }).rsaPin).toBe(
      "PEN100012344421",
    );
    expect(createWorkerSchema.safeParse({ ...base, firstName: "<b>Musa</b>" }).success).toBe(false);
    expect(createWorkerSchema.safeParse({ ...base, lastName: "www.evil.test" }).success).toBe(
      false,
    );
  });

  it("allows one line manager only", () => {
    expect(
      issues(
        createWorkerSchema.safeParse({
          ...base,
          lineManagerWorkerId: WORKER,
          lineManagerMembershipId: OTHER,
        }),
      ),
    ).toEqual({ lineManagerWorkerId: "Choose one line manager" });
  });

  it("reads checkbox values from forms", () => {
    expect(
      createWorkerSchema.parse({ ...base, nhfOptIn: "on", supervisorClockIn: "true" }),
    ).toMatchObject({ nhfOptIn: true, supervisorClockIn: true });
  });
});

describe("updateWorkerSchema", () => {
  it("leaves out unchanged fields, clears blank ones, keeps personal data unless null", () => {
    const data = updateWorkerSchema.parse({
      workerId: WORKER,
      jobTitle: "",
      firstName: "Musa",
      nin: "",
      rsaPin: null,
    });
    expect(data).toEqual({
      workerId: WORKER,
      firstName: "Musa",
      jobTitle: null,
      nin: undefined,
      rsaPin: null,
    });
  });

  it("refuses bank details: they need a second approver", () => {
    const result = updateWorkerSchema.safeParse({
      workerId: WORKER,
      bankAccountNumber: "0123457712",
    });
    expect(issues(result)).toEqual({
      bankAccountNumber:
        "Bank details change through a bank-detail request, which a second person approves",
    });
    expect(updateWorkerSchema.safeParse({ workerId: WORKER, bankName: "" }).success).toBe(true);
  });

  it("refuses a staff ID change: an ID is fixed once saved", () => {
    const result = updateWorkerSchema.safeParse({ workerId: WORKER, staffId: "AFS-0042-OLD" });
    expect(issues(result)).toEqual({ staffId: "A staff ID can't change once it is saved" });
  });
});

describe("pay rate records", () => {
  it("sends whole kobo as strings, with blank monthly allowances as zero", () => {
    const data = addPayRateSchema.parse({
      workerId: WORKER,
      payType: "monthly",
      basic: "105000.50",
      effectiveFrom: "2026-12-01",
    });
    expect(toPayRateRecord(data.payType, data, data.effectiveFrom)).toEqual({
      pay_type: "monthly",
      basic_kobo: "10500050",
      housing_kobo: "0",
      transport_kobo: "0",
      other_allowances_kobo: "0",
      daily_rate_kobo: null,
      hourly_rate_kobo: null,
      effective_from: "2026-12-01",
    });
  });

  it("keeps only the rate that belongs to daily and hourly pay", () => {
    const daily = addPayRateSchema.parse({
      workerId: WORKER,
      payType: "daily",
      dailyRate: "8,000",
      housing: "0",
      effectiveFrom: "2026-12-01",
    });
    expect(toPayRateRecord(daily.payType, daily, daily.effectiveFrom)).toMatchObject({
      daily_rate_kobo: "800000",
      basic_kobo: null,
      housing_kobo: null,
    });
  });

  it("needs a real date", () => {
    expect(
      addPayRateSchema.safeParse({
        workerId: WORKER,
        payType: "daily",
        dailyRate: "8000",
        effectiveFrom: "2026-02-30",
      }).success,
    ).toBe(false);
    expect(endEmploymentSchema.safeParse({ workerId: WORKER, endDate: "31/10/2026" }).success).toBe(
      false,
    );
  });
});
