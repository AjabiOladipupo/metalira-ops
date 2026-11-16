import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PII_KEY_VERSION,
  PiiDecryptError,
  PiiKeyError,
  assertPiiKeyConfigured,
  decryptPii,
  encryptPii,
  encryptPiiForDb,
  parsePiiKey,
  sealPii,
  toByteaHex,
} from "@/server/crypto/pii";

/** A throwaway key per test run. Never a real key. */
const newKey = () => randomBytes(32).toString("base64");

const NUBAN = "0123457712";
const NIN = "12345678901";
const RSA_PIN = "PEN100012344421";

beforeEach(() => {
  vi.stubEnv("PII_ENCRYPTION_KEY", newKey());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("encryptPii and decryptPii", () => {
  it("round-trips personal data, including non-ASCII text", () => {
    for (const value of [NUBAN, NIN, RSA_PIN, "Adébáyọ̀ Ọlá ₦"]) {
      expect(decryptPii(encryptPii(value))).toBe(value);
    }
  });

  it("prefixes the key version and never contains the plaintext", () => {
    const enc = encryptPii(NUBAN);
    expect(enc[0]).toBe(PII_KEY_VERSION);
    expect(enc.length).toBe(1 + 12 + 16 + Buffer.byteLength(NUBAN));
    expect(enc.includes(Buffer.from(NUBAN))).toBe(false);
  });

  it("uses a fresh IV, so equal values give different ciphertexts", () => {
    const a = encryptPii(NUBAN);
    const b = encryptPii(NUBAN);
    expect(a.equals(b)).toBe(false);
    expect(a.subarray(1, 13).equals(b.subarray(1, 13))).toBe(false);
  });

  it("accepts Uint8Array and PostgREST bytea hex text", () => {
    const enc = encryptPii(NIN);
    expect(decryptPii(new Uint8Array(enc))).toBe(NIN);
    expect(decryptPii(toByteaHex(enc))).toBe(NIN);
    expect(toByteaHex(enc)).toMatch(/^\\x[0-9a-f]+$/);
    expect(decryptPii(encryptPiiForDb(RSA_PIN))).toBe(RSA_PIN);
  });

  it("refuses empty and oversized plaintext", () => {
    expect(() => encryptPii("")).toThrow(TypeError);
    expect(() => encryptPii("1".repeat(257))).toThrow(RangeError);
  });
});

describe("tamper detection", () => {
  const flip = (buf: Buffer, index: number) => {
    const copy = Buffer.from(buf);
    copy[index] = (copy[index] ?? 0) ^ 0x01;
    return copy;
  };

  it("rejects a changed byte anywhere: version, IV, tag or ciphertext", () => {
    const enc = encryptPii(NUBAN);
    for (const index of [0, 1, 12, 13, 28, 29, enc.length - 1]) {
      expect(() => decryptPii(flip(enc, index))).toThrow(PiiDecryptError);
    }
  });

  it("rejects truncated, extended and malformed values", () => {
    const enc = encryptPii(NUBAN);
    expect(() => decryptPii(enc.subarray(0, enc.length - 1))).toThrow(PiiDecryptError);
    expect(() => decryptPii(Buffer.concat([enc, Buffer.from([0])]))).toThrow(PiiDecryptError);
    expect(() => decryptPii(enc.subarray(0, 29))).toThrow(PiiDecryptError);
    expect(() => decryptPii(Buffer.alloc(0))).toThrow(PiiDecryptError);
    expect(() => decryptPii("not hex")).toThrow(PiiDecryptError);
    expect(() => decryptPii("\\xzz")).toThrow(PiiDecryptError);
  });

  it("names an unknown key version without decrypting", () => {
    const enc = Buffer.from(encryptPii(NUBAN));
    enc[0] = 9;
    expect(() => decryptPii(enc)).toThrow(/unknown key version 9/);
  });

  it("never puts the plaintext in the error", () => {
    const enc = encryptPii(NUBAN);
    const error = (() => {
      try {
        decryptPii(flip(enc, enc.length - 1));
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).not.toContain(NUBAN);
    expect(error?.message).not.toContain(enc.toString("hex"));
  });
});

describe("key handling", () => {
  it("fails to decrypt under a different key", () => {
    const enc = encryptPii(NUBAN);
    vi.stubEnv("PII_ENCRYPTION_KEY", newKey());
    expect(() => decryptPii(enc)).toThrow(PiiDecryptError);
  });

  it("fails closed when the key is missing, without echoing anything", () => {
    vi.stubEnv("PII_ENCRYPTION_KEY", "");
    expect(() => encryptPii(NUBAN)).toThrow(PiiKeyError);
    expect(() => assertPiiKeyConfigured()).toThrow(/PII_ENCRYPTION_KEY is not set/);
    vi.stubEnv("PII_ENCRYPTION_KEY", undefined);
    expect(() => encryptPii(NUBAN)).toThrow(PiiKeyError);
  });

  it("decrypt also fails closed when the key goes missing", () => {
    const enc = encryptPii(NUBAN);
    vi.stubEnv("PII_ENCRYPTION_KEY", "");
    expect(() => decryptPii(enc)).toThrow(PiiKeyError);
  });

  it("rejects keys that are not exactly 32 bytes of standard base64", () => {
    const bad = [
      randomBytes(16).toString("base64"),
      randomBytes(31).toString("base64"),
      randomBytes(33).toString("base64"),
      randomBytes(32).toString("hex"),
      randomBytes(32).toString("base64url"),
      "x".repeat(44),
    ];
    for (const raw of bad) {
      expect(() => parsePiiKey(raw)).toThrow(PiiKeyError);
      try {
        parsePiiKey(raw);
      } catch (e) {
        expect((e as Error).message).not.toContain(raw);
      }
    }
  });

  it("accepts a valid key with surrounding whitespace", () => {
    const raw = newKey();
    expect(parsePiiKey(`  ${raw}\n`)).toHaveLength(32);
  });

  it("reads the key on use, not at import", async () => {
    vi.stubEnv("PII_ENCRYPTION_KEY", "");
    vi.resetModules();
    await expect(import("@/server/crypto/pii")).resolves.toBeDefined();
  });
});

describe("sealPii", () => {
  it("returns the bytea value and its last four digits", () => {
    const sealed = sealPii(NUBAN);
    expect(sealed.last4).toBe("7712");
    expect(decryptPii(sealed.enc)).toBe(NUBAN);
    expect(sealPii(RSA_PIN).last4).toBe("4421");
    expect(sealPii("12").last4).toBeNull();
  });
});
