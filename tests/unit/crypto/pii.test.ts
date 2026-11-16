import { randomBytes, randomUUID } from "node:crypto";

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
  type PiiContext,
} from "@/server/crypto/pii";

/** A throwaway key per test run. Never a real key. */
const newKey = () => randomBytes(32).toString("base64");

const NUBAN = "0123457712";
const NIN = "12345678901";
const RSA_PIN = "PEN100012344421";

const ORG = "a0000000-0000-4000-8000-000000000001";
const OTHER_ORG = "a0000000-0000-4000-8000-000000000009";
const ROW = "b0000000-0000-4000-8000-000000000002";
const OTHER_ROW = "b0000000-0000-4000-8000-000000000003";

const CTX: PiiContext = {
  organisationId: ORG,
  table: "workers",
  column: "bank_account_enc",
  rowId: ROW,
};

beforeEach(() => {
  vi.stubEnv("PII_ENCRYPTION_KEY", newKey());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("encryptPii and decryptPii", () => {
  it("round-trips personal data, including non-ASCII text", () => {
    for (const value of [NUBAN, NIN, RSA_PIN, "Adébáyọ̀ Ọlá ₦"]) {
      expect(decryptPii(encryptPii(value, CTX), CTX)).toBe(value);
    }
  });

  it("prefixes the key version and never contains the plaintext", () => {
    const enc = encryptPii(NUBAN, CTX);
    expect(enc[0]).toBe(PII_KEY_VERSION);
    expect(enc.length).toBe(1 + 12 + 16 + Buffer.byteLength(NUBAN));
    expect(enc.includes(Buffer.from(NUBAN))).toBe(false);
  });

  it("uses a fresh IV, so equal values give different ciphertexts", () => {
    const a = encryptPii(NUBAN, CTX);
    const b = encryptPii(NUBAN, CTX);
    expect(a.equals(b)).toBe(false);
    expect(a.subarray(1, 13).equals(b.subarray(1, 13))).toBe(false);
  });

  it("accepts Uint8Array and PostgREST bytea hex text", () => {
    const enc = encryptPii(NIN, CTX);
    expect(decryptPii(new Uint8Array(enc), CTX)).toBe(NIN);
    expect(decryptPii(toByteaHex(enc), CTX)).toBe(NIN);
    expect(toByteaHex(enc)).toMatch(/^\\x[0-9a-f]+$/);
    expect(decryptPii(encryptPiiForDb(RSA_PIN, CTX), CTX)).toBe(RSA_PIN);
  });

  it("refuses empty and oversized plaintext", () => {
    expect(() => encryptPii("", CTX)).toThrow(TypeError);
    expect(() => encryptPii("1".repeat(257), CTX)).toThrow(RangeError);
  });
});

describe("context binding", () => {
  it("fails when a value is moved to another column of the same row", () => {
    const nin = encryptPii(NIN, { ...CTX, column: "nin_enc" });
    expect(() => decryptPii(nin, { ...CTX, column: "bank_account_enc" })).toThrow(PiiDecryptError);
    expect(decryptPii(nin, { ...CTX, column: "nin_enc" })).toBe(NIN);
  });

  it("fails when a value is moved to another row", () => {
    const enc = encryptPii(NUBAN, CTX);
    expect(() => decryptPii(enc, { ...CTX, rowId: OTHER_ROW })).toThrow(PiiDecryptError);
  });

  it("fails when a value is moved to another table", () => {
    const enc = encryptPii(NUBAN, CTX);
    expect(() => decryptPii(enc, { ...CTX, table: "bank_detail_changes" })).toThrow(
      PiiDecryptError,
    );
  });

  it("fails when a value is moved to another organisation", () => {
    const enc = encryptPii(NUBAN, CTX);
    expect(() => decryptPii(enc, { ...CTX, organisationId: OTHER_ORG })).toThrow(PiiDecryptError);
  });

  it("treats UUID case as the same place, as Postgres does", () => {
    const enc = encryptPii(NUBAN, CTX);
    const upper = { ...CTX, organisationId: ORG.toUpperCase(), rowId: ROW.toUpperCase() };
    expect(decryptPii(enc, upper)).toBe(NUBAN);
  });

  it("works with row ids generated before insert", () => {
    const ctx = { ...CTX, rowId: randomUUID() };
    expect(decryptPii(encryptPii(NUBAN, ctx), ctx)).toBe(NUBAN);
  });

  it("refuses a missing or malformed context before encrypting", () => {
    const bad: unknown[] = [
      undefined,
      null,
      { ...CTX, organisationId: "not-a-uuid" },
      { ...CTX, rowId: "" },
      { ...CTX, table: "Workers" },
      { ...CTX, table: "workers|x" },
      { ...CTX, column: "bank_account" },
      { ...CTX, column: "nin_enc|x_enc" },
    ];
    for (const ctx of bad) {
      expect(() => encryptPii(NUBAN, ctx as PiiContext)).toThrow(TypeError);
    }
    const enc = encryptPii(NUBAN, CTX);
    expect(() => decryptPii(enc, { ...CTX, column: "bank_account" })).toThrow(TypeError);
  });
});

describe("tamper detection", () => {
  const flip = (buf: Buffer, index: number) => {
    const copy = Buffer.from(buf);
    copy[index] = (copy[index] ?? 0) ^ 0x01;
    return copy;
  };

  it("rejects a changed byte anywhere: version, IV, tag or ciphertext", () => {
    const enc = encryptPii(NUBAN, CTX);
    for (const index of [0, 1, 12, 13, 28, 29, enc.length - 1]) {
      expect(() => decryptPii(flip(enc, index), CTX)).toThrow(PiiDecryptError);
    }
  });

  it("rejects truncated, extended and malformed values", () => {
    const enc = encryptPii(NUBAN, CTX);
    expect(() => decryptPii(enc.subarray(0, enc.length - 1), CTX)).toThrow(PiiDecryptError);
    expect(() => decryptPii(Buffer.concat([enc, Buffer.from([0])]), CTX)).toThrow(PiiDecryptError);
    expect(() => decryptPii(enc.subarray(0, 29), CTX)).toThrow(PiiDecryptError);
    expect(() => decryptPii(Buffer.alloc(0), CTX)).toThrow(PiiDecryptError);
    expect(() => decryptPii("not hex", CTX)).toThrow(PiiDecryptError);
    expect(() => decryptPii("\\xzz", CTX)).toThrow(PiiDecryptError);
  });

  it("names an unknown key version without decrypting", () => {
    const enc = Buffer.from(encryptPii(NUBAN, CTX));
    enc[0] = 9;
    expect(() => decryptPii(enc, CTX)).toThrow(/unknown key version 9/);
  });

  it("never puts the plaintext in the error", () => {
    const enc = encryptPii(NUBAN, CTX);
    const error = (() => {
      try {
        decryptPii(flip(enc, enc.length - 1), CTX);
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
    const enc = encryptPii(NUBAN, CTX);
    vi.stubEnv("PII_ENCRYPTION_KEY", newKey());
    expect(() => decryptPii(enc, CTX)).toThrow(PiiDecryptError);
  });

  it("fails closed when the key is missing, without echoing anything", () => {
    vi.stubEnv("PII_ENCRYPTION_KEY", "");
    expect(() => encryptPii(NUBAN, CTX)).toThrow(PiiKeyError);
    expect(() => assertPiiKeyConfigured()).toThrow(/PII_ENCRYPTION_KEY is not set/);
    vi.stubEnv("PII_ENCRYPTION_KEY", undefined);
    expect(() => encryptPii(NUBAN, CTX)).toThrow(PiiKeyError);
  });

  it("decrypt also fails closed when the key goes missing", () => {
    const enc = encryptPii(NUBAN, CTX);
    vi.stubEnv("PII_ENCRYPTION_KEY", "");
    expect(() => decryptPii(enc, CTX)).toThrow(PiiKeyError);
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
    const sealed = sealPii(NUBAN, CTX);
    expect(sealed.last4).toBe("7712");
    expect(decryptPii(sealed.enc, CTX)).toBe(NUBAN);
    const rsa = { ...CTX, column: "rsa_pin_enc" };
    expect(sealPii(RSA_PIN, rsa).last4).toBe("4421");
    expect(sealPii("12", CTX).last4).toBeNull();
  });

  it("binds the sealed value to its context", () => {
    const sealed = sealPii(NUBAN, CTX);
    expect(() => decryptPii(sealed.enc, { ...CTX, rowId: OTHER_ROW })).toThrow(PiiDecryptError);
  });
});
