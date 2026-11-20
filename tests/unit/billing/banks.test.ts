import { describe, expect, it } from "vitest";

import { NIGERIAN_BANKS, bankByCode, bankFromName, searchBanks } from "@/lib/banks";

describe("the bank list", () => {
  it("has unique, well-formed codes and unique names", () => {
    const codes = NIGERIAN_BANKS.map((b) => b.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^\d{3,6}$/);
    const names = NIGERIAN_BANKS.map((b) => b.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it("carries the CBN codes of the main commercial banks", () => {
    // From Monnify's Supported Banks page (src/lib/banks.ts names the source).
    const expected: Record<string, string> = {
      "044": "Access Bank",
      "058": "GTBank (Guaranty Trust Bank)",
      "057": "Zenith Bank",
      "033": "United Bank for Africa (UBA)",
      "011": "First Bank of Nigeria",
      "070": "Fidelity Bank",
      "214": "First City Monument Bank (FCMB)",
      "032": "Union Bank of Nigeria",
      "232": "Sterling Bank",
      "035": "Wema Bank",
      "221": "Stanbic IBTC Bank",
      "050": "Ecobank Nigeria",
      "076": "Polaris Bank",
      "082": "Keystone Bank",
      "101": "Providus Bank",
      "301": "Jaiz Bank",
      "102": "Titan Trust Bank",
      "103": "Globus Bank",
      "105": "PremiumTrust Bank",
      "907": "Parallex Bank",
      "303": "Lotus Bank",
    };
    for (const [code, name] of Object.entries(expected)) {
      expect(bankByCode(code)?.name).toBe(name);
    }
  });

  it("carries the NIBSS codes of the fintech and microfinance banks people use", () => {
    expect(bankByCode("999992")?.name).toBe("OPay");
    expect(bankByCode("50515")?.name).toBe("Moniepoint Microfinance Bank");
    expect(bankByCode("50211")?.name).toBe("Kuda Microfinance Bank");
    expect(bankByCode("100033")?.name).toBe("PalmPay");
    expect(bankByCode("566")?.name).toBe("VFD Microfinance Bank");
    expect(bankByCode("123")).toBeUndefined();
    expect(bankByCode("")).toBeUndefined();
  });

  it("covers every kind of bank", () => {
    const kinds = new Set(NIGERIAN_BANKS.map((b) => b.kind));
    for (const kind of [
      "commercial",
      "merchant",
      "non_interest",
      "microfinance",
      "payment_service",
      "mobile_money",
    ]) {
      expect(kinds.has(kind as never)).toBe(true);
    }
  });
});

describe("bankFromName", () => {
  it.each([
    ["GTB", "058"],
    ["Guaranty Trust Bank Plc", "058"],
    ["gt bank", "058"],
    ["First Bank", "011"],
    ["FirstBank Nigeria Ltd", "011"],
    ["Access Bank Plc", "044"],
    ["UBA", "033"],
    ["Opay", "999992"],
    ["Moniepoint MFB", "50515"],
    ["Kuda Bank", "50211"],
    ["Stanbic IBTC", "221"],
    ["Zenith Bank PLC", "057"],
  ])("reads %s as %s", (name, code) => {
    expect(bankFromName(name)?.code).toBe(code);
  });

  it("gives nothing for a name it can't place", () => {
    expect(bankFromName("My bank")).toBeUndefined();
    expect(bankFromName("")).toBeUndefined();
    expect(bankFromName(null)).toBeUndefined();
  });
});

describe("searchBanks", () => {
  it("puts names starting with the query first, and finds aliases and codes", () => {
    expect(searchBanks("zen")[0]?.code).toBe("057");
    expect(searchBanks("gtb")[0]?.code).toBe("058");
    expect(searchBanks("guaranty")[0]?.code).toBe("058");
    expect(searchBanks("palm")[0]?.code).toBe("100033");
    expect(searchBanks("044")[0]?.code).toBe("044");
    expect(searchBanks("")).toHaveLength(NIGERIAN_BANKS.length);
    expect(searchBanks("xyzzy")).toEqual([]);
  });
});
