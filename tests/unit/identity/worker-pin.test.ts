/**
 * Slice 1.9: worker PIN hashing (scrypt with a pepper derived from the personal data key) and
 * the PIN rules. A throwaway key is generated here; no real key is ever needed.
 */
import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// scrypt is deliberately slow; leave room when the machine is busy.
vi.setConfig({ testTimeout: 30_000 });

import { derivePiiSubkey } from "@/server/crypto/pii";
import { hashPin, isWeakPin, newPinSchema, pinSchema, verifyPin } from "@/server/identity/pin";

const newKey = () => randomBytes(32).toString("base64");

beforeEach(() => {
  vi.stubEnv("PII_ENCRYPTION_KEY", newKey());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hashPin and verifyPin", () => {
  it("verifies the right PIN and refuses a wrong one", async () => {
    const stored = await hashPin("482913");
    expect(await verifyPin("482913", stored)).toBe(true);
    expect(await verifyPin("482914", stored)).toBe(false);
    expect(await verifyPin("000000", stored)).toBe(false);
  });

  it("stores a versioned scrypt hash with a fresh salt, never the PIN", async () => {
    const a = await hashPin("482913");
    const b = await hashPin("482913");
    expect(a).toMatch(/^s1\$k1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("482913");
  });

  it("is false, not an error, with no stored hash or a malformed one", async () => {
    expect(await verifyPin("482913", null)).toBe(false);
    expect(await verifyPin("482913", undefined)).toBe(false);
    expect(await verifyPin("482913", "")).toBe(false);
    expect(await verifyPin("482913", "s1$k1$short$short")).toBe(false);
    expect(await verifyPin("482913", "plain-text-pin-482913")).toBe(false);
  });

  it("refuses a PIN that is not 6 digits even against its own hash", async () => {
    const stored = await hashPin("482913");
    expect(await verifyPin("48291", stored)).toBe(false);
    expect(await verifyPin("4829130", stored)).toBe(false);
    expect(await verifyPin("48291a", stored)).toBe(false);
  });

  it("depends on the server-side pepper: a hash is useless under another key", async () => {
    const stored = await hashPin("482913");
    vi.stubEnv("PII_ENCRYPTION_KEY", newKey());
    expect(await verifyPin("482913", stored)).toBe(false);
  });

  it("refuses to hash anything but 6 digits", async () => {
    await expect(hashPin("12345")).rejects.toThrow(TypeError);
    await expect(hashPin("abcdef")).rejects.toThrow(TypeError);
  });

  it("fails closed without the key", async () => {
    vi.stubEnv("PII_ENCRYPTION_KEY", "");
    await expect(hashPin("482913")).rejects.toThrow(/PII_ENCRYPTION_KEY is not set/);
  });
});

describe("derivePiiSubkey", () => {
  it("gives a stable 32-byte key per purpose, different across purposes and keys", () => {
    const a = derivePiiSubkey("worker-pin-pepper");
    expect(a).toHaveLength(32);
    expect(derivePiiSubkey("worker-pin-pepper").equals(a)).toBe(true);
    expect(derivePiiSubkey("another-purpose").equals(a)).toBe(false);
    vi.stubEnv("PII_ENCRYPTION_KEY", newKey());
    expect(derivePiiSubkey("worker-pin-pepper").equals(a)).toBe(false);
  });

  it("refuses an odd purpose name", () => {
    expect(() => derivePiiSubkey("Worker Pepper")).toThrow(TypeError);
  });
});

describe("PIN rules", () => {
  it.each(["111111", "000000", "123456", "654321", "234567", "987654", "901234"])(
    "%s is too easy to guess",
    (pin) => {
      expect(isWeakPin(pin)).toBe(true);
      expect(newPinSchema.safeParse(pin).success).toBe(false);
    },
  );

  it.each(["482913", "120934", "112233", "135790"])("%s is allowed", (pin) => {
    expect(isWeakPin(pin)).toBe(false);
    expect(newPinSchema.safeParse(pin).success).toBe(true);
  });

  it.each(["12345", "1234567", "12345a", " 48291", "", "４８２９１３"])(
    "%j is not a 6-digit PIN",
    (pin) => {
      expect(pinSchema.safeParse(pin).success).toBe(false);
      expect(newPinSchema.safeParse(pin).success).toBe(false);
    },
  );

  it("accepts any 6 digits at sign-in, even an easy one set before the rule", () => {
    expect(pinSchema.safeParse("123456").success).toBe(true);
  });
});
