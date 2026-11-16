import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { last4 } from "@/lib/mask";

/**
 * Column-level encryption for personal data (CLAUDE.md rule 9): NIN, bank account numbers and
 * RSA PINs, stored as `bytea` in `_enc` columns.
 *
 * Format of one stored value (all lengths in bytes):
 *
 *   [ version: 1 ][ iv: 12 ][ auth tag: 16 ][ ciphertext: n ]
 *
 * - AES-256-GCM with a fresh random 96-bit IV for every value, so equal plaintexts never give
 *   equal ciphertexts.
 * - The version byte names the key. It is also bound into the tag as additional authenticated
 *   data, so it cannot be changed without decryption failing.
 * - Key version 1 is `PII_ENCRYPTION_KEY`: 32 random bytes, base64-encoded. Rotation adds a new
 *   version byte and a second variable; old values keep decrypting under their own version.
 *
 * The key is read on first use, never at import time, so builds and pages that never touch
 * personal data work without it. A missing or malformed key fails closed with `PiiKeyError` in
 * every environment. Error messages never contain plaintext, ciphertext or key material.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

/** The key version new values are written with. */
export const PII_KEY_VERSION = 1;

/** Longest plaintext accepted. Personal data fields are short; this bounds bad input. */
const MAX_PLAINTEXT_LENGTH = 256;

/** 32 bytes in standard base64 is exactly 43 characters plus one `=` of padding. */
const BASE64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/;

/** `PII_ENCRYPTION_KEY` is missing or is not 32 bytes of base64. */
export class PiiKeyError extends Error {
  override name = "PiiKeyError";
}

/** A stored value could not be decrypted: tampered, truncated, wrong key or unknown version. */
export class PiiDecryptError extends Error {
  override name = "PiiDecryptError";
}

const KEY_HELP =
  "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"";

let cached: { raw: string; key: Buffer } | null = null;

/** Parses and checks a base64 key. Exported for tests; the value is never echoed in errors. */
export function parsePiiKey(raw: string | undefined): Buffer {
  const value = raw?.trim();
  if (!value) {
    throw new PiiKeyError(`PII_ENCRYPTION_KEY is not set. ${KEY_HELP}`);
  }
  const key = BASE64_32_BYTES.test(value) ? Buffer.from(value, "base64") : null;
  if (!key || key.length !== KEY_BYTES) {
    throw new PiiKeyError(`PII_ENCRYPTION_KEY must be 32 bytes, base64-encoded. ${KEY_HELP}`);
  }
  return key;
}

function keyFor(version: number): Buffer {
  if (version !== PII_KEY_VERSION) {
    throw new PiiDecryptError(`Encrypted value uses unknown key version ${version}.`);
  }
  const raw = process.env.PII_ENCRYPTION_KEY ?? "";
  if (cached?.raw !== raw) cached = { raw, key: parsePiiKey(raw) };
  return cached.key;
}

/** Fails fast with `PiiKeyError` when the key is missing or malformed. Call from a health check. */
export function assertPiiKeyConfigured(): void {
  keyFor(PII_KEY_VERSION);
}

/** Encrypts one personal data value. Store the result in a `bytea` `_enc` column. */
export function encryptPii(plaintext: string): Buffer {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new TypeError("encryptPii needs a non-empty string. Store null for a missing value.");
  }
  if (plaintext.length > MAX_PLAINTEXT_LENGTH) {
    throw new RangeError(`encryptPii accepts at most ${MAX_PLAINTEXT_LENGTH} characters.`);
  }
  const key = keyFor(PII_KEY_VERSION);
  const header = Buffer.from([PII_KEY_VERSION]);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([header, iv, cipher.getAuthTag(), ciphertext]);
}

/** A stored value as it arrives: a Buffer, raw bytes, or PostgREST's `\x…` hex text. */
export type PiiCiphertext = Buffer | Uint8Array | string;

function toBuffer(value: PiiCiphertext): Buffer {
  if (typeof value === "string") {
    // PostgREST and supabase-js return bytea as hex text with a `\x` prefix.
    if (!/^\\x(?:[0-9a-fA-F]{2})*$/.test(value)) {
      throw new PiiDecryptError("Encrypted value is not bytea hex text.");
    }
    return Buffer.from(value.slice(2), "hex");
  }
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

/** Decrypts a value written by `encryptPii`. Throws `PiiDecryptError` if it was altered. */
export function decryptPii(value: PiiCiphertext): string {
  const data = toBuffer(value);
  if (data.length <= HEADER_BYTES) {
    throw new PiiDecryptError("Encrypted value is too short.");
  }
  const version = data[0] ?? 0;
  const key = keyFor(version);
  const iv = data.subarray(1, 1 + IV_BYTES);
  const tag = data.subarray(1 + IV_BYTES, HEADER_BYTES);
  const ciphertext = data.subarray(HEADER_BYTES);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(data.subarray(0, 1));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (cause) {
    throw new PiiDecryptError("Encrypted value failed its integrity check.", { cause });
  }
}

/** Bytes as PostgREST `bytea` input (`\x` + hex), for writes through supabase-js. */
export function toByteaHex(value: Buffer | Uint8Array): string {
  return `\\x${Buffer.from(value).toString("hex")}`;
}

/** `encryptPii` in the form supabase-js writes to a `bytea` column. */
export function encryptPiiForDb(plaintext: string): string {
  return toByteaHex(encryptPii(plaintext));
}

/**
 * The `_enc` value and its `_last4` sibling for one field, so lists show a masked value without
 * decrypting. `last4` is the last four digits, or null when the value has fewer than four.
 */
export function sealPii(plaintext: string): { enc: string; last4: string | null } {
  return { enc: encryptPiiForDb(plaintext), last4: last4(plaintext) };
}

export { last4 };
