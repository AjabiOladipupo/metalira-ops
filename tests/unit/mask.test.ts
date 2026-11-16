import { describe, expect, it } from "vitest";

import {
  PII_FIELDS,
  isNinFormat,
  last4,
  maskAccount,
  maskNin,
  maskPhone,
  maskPii,
  maskRsaPin,
  ninStatus,
} from "@/lib/mask";

describe("last4", () => {
  it("takes the last four digits and ignores formatting", () => {
    expect(last4("0123457712")).toBe("7712");
    expect(last4("PEN100012344421")).toBe("4421");
    expect(last4("0803 123 4410")).toBe("4410");
    expect(last4("7712")).toBe("7712");
  });

  it("is null when there are fewer than four digits", () => {
    expect(last4("123")).toBeNull();
    expect(last4("")).toBeNull();
    expect(last4(null)).toBeNull();
    expect(last4(undefined)).toBeNull();
  });
});

describe("maskAccount", () => {
  it("shows the last four digits only, from the full value or last4", () => {
    expect(maskAccount("0123457712")).toBe("••••7712");
    expect(maskAccount("7712")).toBe("••••7712");
  });

  it("hides short values entirely and returns empty for nothing", () => {
    expect(maskAccount("12")).toBe("••••");
    expect(maskAccount(null)).toBe("");
    expect(maskAccount("")).toBe("");
  });
});

describe("maskRsaPin", () => {
  it("keeps the PEN prefix and the last four digits", () => {
    expect(maskRsaPin("PEN100012344421")).toBe("PEN••••4421");
    expect(maskRsaPin("4421")).toBe("PEN••••4421");
    expect(maskRsaPin(undefined)).toBe("");
  });
});

describe("maskPhone", () => {
  it("masks the middle of a local number", () => {
    expect(maskPhone("08031234410")).toBe("0803 ••• 4410");
    expect(maskPhone("0803 123 4410")).toBe("0803 ••• 4410");
  });

  it("shows international forms in the local form", () => {
    expect(maskPhone("+2348031234410")).toBe("0803 ••• 4410");
    expect(maskPhone("2348031234410")).toBe("0803 ••• 4410");
  });

  it("keeps only the last four digits of anything else", () => {
    expect(maskPhone("4410")).toBe("••• 4410");
    expect(maskPhone("12")).toBe("•••");
    expect(maskPhone(null)).toBe("");
  });
});

describe("maskNin", () => {
  it("shows the last four digits only", () => {
    expect(maskNin("12345678901")).toBe("•••••••8901");
    expect(maskNin("")).toBe("");
  });

  it("never reports a NIN as verified", () => {
    expect(ninStatus(true)).toBe("On file");
    expect(ninStatus(false)).toBe("Missing");
  });

  it("checks the 11-digit format only", () => {
    expect(isNinFormat("12345678901")).toBe(true);
    expect(isNinFormat(" 12345678901 ")).toBe(true);
    expect(isNinFormat("1234567890")).toBe(false);
    expect(isNinFormat("123456789012")).toBe(false);
    expect(isNinFormat("1234567890a")).toBe(false);
    expect(isNinFormat(null)).toBe(false);
  });
});

describe("maskPii", () => {
  it("masks every field and never returns the full value", () => {
    const full = { nin: "12345678901", bank_account: "0123457712", rsa_pin: "PEN100012344421" };
    for (const field of PII_FIELDS) {
      const masked = maskPii(field, full[field]);
      expect(masked).not.toBe("");
      expect(masked).not.toContain(full[field]);
    }
    expect(maskPii("bank_account", "7712")).toBe("••••7712");
    expect(maskPii("rsa_pin", "4421")).toBe("PEN••••4421");
  });
});
