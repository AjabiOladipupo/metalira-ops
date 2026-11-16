import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { koboFromText, listPayRates, PAY_RATE_SELECT } from "@/server/people/pay-rates";
import type { Database } from "@/types/db";

const ORG = "a0000000-0000-4000-8000-000000000001";
const WORKER = "b0000000-0000-4000-8000-000000000002";

describe("koboFromText", () => {
  it("reads whole kobo beyond the safe-integer range exactly", () => {
    expect(koboFromText("1000000000000000")).toBe(1_000_000_000_000_000n);
    // 12 months x 4 x 10^15 would not survive a JavaScript number.
    expect(koboFromText("48000000000000000")! + 1n).toBe(48_000_000_000_000_001n);
    expect(koboFromText(null)).toBeNull();
  });

  it("refuses anything but whole kobo", () => {
    expect(() => koboFromText("1000.5")).toThrow(RangeError);
    expect(() => koboFromText("")).toThrow(RangeError);
  });
});

describe("listPayRates", () => {
  it("selects every amount cast to text and returns bigint kobo", async () => {
    const calls: unknown[][] = [];
    const builder = {
      select: (columns: string) => (calls.push(["select", columns]), builder),
      eq: (column: string, value: string) => (calls.push(["eq", column, value]), builder),
      order: (column: string) => {
        calls.push(["order", column]);
        return Promise.resolve({
          data: [
            {
              id: "r1",
              worker_id: WORKER,
              pay_type: "monthly",
              currency: "NGN",
              effective_from: "2025-01-06",
              effective_to: null,
              basic_kobo: "10500050",
              housing_kobo: "6300000",
              transport_kobo: "4200000",
              other_allowances_kobo: "0",
              daily_rate_kobo: null,
              hourly_rate_kobo: null,
            },
          ],
          error: null,
        });
      },
    };
    const from = vi.fn(() => builder);
    const client = { from } as unknown as SupabaseClient<Database>;

    const rows = await listPayRates(client, ORG, WORKER);

    expect(from).toHaveBeenCalledWith("pay_rates");
    expect(calls).toContainEqual(["eq", "organisation_id", ORG]);
    expect(calls).toContainEqual(["eq", "worker_id", WORKER]);
    for (const column of [
      "basic_kobo",
      "housing_kobo",
      "transport_kobo",
      "other_allowances_kobo",
      "daily_rate_kobo",
      "hourly_rate_kobo",
    ]) {
      expect(PAY_RATE_SELECT).toContain(`${column}::text`);
    }
    expect(rows).toEqual([
      {
        id: "r1",
        workerId: WORKER,
        payType: "monthly",
        currency: "NGN",
        effectiveFrom: "2025-01-06",
        effectiveTo: null,
        basic: 10_500_050n,
        housing: 6_300_000n,
        transport: 4_200_000n,
        otherAllowances: 0n,
        dailyRate: null,
        hourlyRate: null,
      },
    ]);
  });
});
