import "server-only";

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

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
 * - The version byte names the key. It is bound into the tag as additional authenticated data
 *   (AAD), so it cannot be changed without decryption failing.
 * - The value's place is bound in too. The AAD is the version byte followed by
 *   `<organisation_id>|<table>|<column>|<row_id>`. A ciphertext copied into another column,
 *   row or organisation fails its integrity check, so a user who can write rows but may not
 *   read personal data (admin) cannot splice a NIN into a bank account field that finance may
 *   reveal. What this means for writers:
 *   - The row id must be known before the insert: generate it with `crypto.randomUUID()` and
 *     insert it explicitly instead of relying on the column default.
 *   - Moving a value to another row or table means decrypting under the old context and
 *     encrypting under the new one on the server. Bytes copied in SQL will not decrypt.
 *   - A value that waits elsewhere before reaching its column is encrypted for its destination
 *     from the start: a bank-detail change (slice 1.7) holds the new account number encrypted
 *     for `workers.bank_account_enc` of the worker, so the database copies it into the worker
 *     when the 72-hour hold ends, and a reveal of the request decrypts under that context.
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

/**
 * A stored value could not be decrypted: tampered, truncated, wrong key, unknown version, or
 * written for a different organisation, table, column or row.
 */
export class PiiDecryptError extends Error {
  override name = "PiiDecryptError";
}

/** Where a value lives. Bound into the authentication tag; see the format notes above. */
export interface PiiContext {
  organisationId: string;
  /** Table name, for example `workers`. */
  table: string;
  /** The `_enc` column, for example `nin_enc`. */
  column: string;
  /** The row's primary key. */
  rowId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * The AAD for one value: the version byte, then the canonical context. UUIDs are lower-cased
 * (Postgres returns them that way) and identifiers cannot contain `|`, so the joined form is
 * unambiguous. Throws `TypeError` for a malformed context before any crypto runs.
 */
function aadFor(version: number, ctx: PiiContext): Buffer {
  if (!ctx || typeof ctx !== "object") {
    throw new TypeError("Personal data needs its context: organisation, table, column and row.");
  }
  const { organisationId, table, column, rowId } = ctx;
  if (typeof organisationId !== "string" || !UUID.test(organisationId)) {
    throw new TypeError("PiiContext.organisationId must be a UUID.");
  }
  if (typeof rowId !== "string" || !UUID.test(rowId)) {
    throw new TypeError("PiiContext.rowId must be a UUID.");
  }
  if (typeof table !== "string" || !IDENTIFIER.test(table)) {
    throw new TypeError("PiiContext.table must be a lower-case table name.");
  }
  if (typeof column !== "string" || !IDENTIFIER.test(column) || !column.endsWith("_enc")) {
    throw new TypeError("PiiContext.column must be an `_enc` column name.");
  }
  const canonical = `${organisationId.toLowerCase()}|${table}|${column}|${rowId.toLowerCase()}`;
  return Buffer.concat([Buffer.from([version]), Buffer.from(canonical, "utf8")]);
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

const SUBKEY_PURPOSE = /^[a-z][a-z0-9-]{0,62}$/;
const subkeys = new Map<string, { raw: Buffer; key: Buffer }>();

/**
 * A 32-byte key for another server-side secret (for example the PIN pepper in
 * src/server/identity/pin.ts), derived from personal data key `version` with HKDF-SHA256 and
 * the purpose as `info`. Different purposes give unrelated keys, and none reveals the key it
 * came from. Old versions keep deriving the same subkey after a rotation, so values stamped
 * with their version keep verifying.
 */
export function derivePiiSubkey(purpose: string, version: number = PII_KEY_VERSION): Buffer {
  if (!SUBKEY_PURPOSE.test(purpose)) {
    throw new TypeError("derivePiiSubkey needs a lower-case purpose name.");
  }
  const raw = keyFor(version);
  const id = `${version}:${purpose}`;
  const hit = subkeys.get(id);
  if (hit && hit.raw.equals(raw)) return hit.key;
  const key = Buffer.from(
    hkdfSync("sha256", raw, Buffer.alloc(0), `metalira-ops/${purpose}`, KEY_BYTES),
  );
  subkeys.set(id, { raw, key });
  return key;
}

/**
 * Encrypts one personal data value for the place `ctx` names. Store the result in exactly that
 * `bytea` `_enc` column of that row.
 */
export function encryptPii(plaintext: string, ctx: PiiContext): Buffer {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new TypeError("encryptPii needs a non-empty string. Store null for a missing value.");
  }
  if (plaintext.length > MAX_PLAINTEXT_LENGTH) {
    throw new RangeError(`encryptPii accepts at most ${MAX_PLAINTEXT_LENGTH} characters.`);
  }
  const aad = aadFor(PII_KEY_VERSION, ctx);
  const key = keyFor(PII_KEY_VERSION);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([PII_KEY_VERSION]), iv, cipher.getAuthTag(), ciphertext]);
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

/**
 * Decrypts a value written by `encryptPii` with the same `ctx`. Throws `PiiDecryptError` if it
 * was altered or was written for another organisation, table, column or row.
 */
export function decryptPii(value: PiiCiphertext, ctx: PiiContext): string {
  const data = toBuffer(value);
  if (data.length <= HEADER_BYTES) {
    throw new PiiDecryptError("Encrypted value is too short.");
  }
  const version = data[0] ?? 0;
  const key = keyFor(version);
  const aad = aadFor(version, ctx);
  const iv = data.subarray(1, 1 + IV_BYTES);
  const tag = data.subarray(1 + IV_BYTES, HEADER_BYTES);
  const ciphertext = data.subarray(HEADER_BYTES);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
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
export function encryptPiiForDb(plaintext: string, ctx: PiiContext): string {
  return toByteaHex(encryptPii(plaintext, ctx));
}

/**
 * The `_enc` value and its `_last4` sibling for one field, so lists show a masked value without
 * decrypting. `last4` is the last four digits, or null when the value has fewer than four.
 */
export function sealPii(plaintext: string, ctx: PiiContext): { enc: string; last4: string | null } {
  return { enc: encryptPiiForDb(plaintext, ctx), last4: last4(plaintext) };
}

export { last4 };
