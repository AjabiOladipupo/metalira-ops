import "server-only";

import { createHmac, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

import { z } from "zod";

import { derivePiiSubkey, PII_KEY_VERSION } from "@/server/crypto/pii";

/**
 * Worker PINs (owner decision 6: 6 digits). Hashed with scrypt from node:crypto, a fresh
 * 16-byte salt per PIN, and a server-side pepper.
 *
 * A 6-digit PIN has only a million values, so a slow hash alone would not stop someone holding
 * a copy of the database from trying them all. The pepper (an HMAC key derived from
 * PII_ENCRYPTION_KEY, which never reaches the database) makes a stolen hash useless on its own.
 * Online guessing is stopped by the lock: 5 wrong tries lock sign-in for 15 minutes
 * (public.worker_sign_in_begin).
 *
 * Stored format: `s1$k<key version>$<salt, base64url>$<hash, base64url>`. `s1` names the
 * parameters below (scrypt N=2^15, r=8, p=1, 32-byte output); the key version names the
 * pepper, so a key rotation keeps old PINs verifying.
 */

export const PIN_LENGTH = 6;

const FORMAT = "s1";
const PEPPER_PURPOSE = "worker-pin-pepper";
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const SCRYPT_OPTIONS: ScryptOptions = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const STORED = /^s1\$k([0-9]{1,3})\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;

/** PINs nobody should use: one digit repeated, or a straight run up or down. */
export function isWeakPin(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true;
  const digits = [...pin].map(Number);
  const steps = new Set(digits.slice(1).map((d, i) => (d - (digits[i] ?? 0) + 10) % 10));
  return steps.size === 1 && (steps.has(1) || steps.has(9));
}

/** A PIN as typed at sign-in: exactly 6 digits. */
export const pinSchema = z
  .string()
  .regex(new RegExp(`^[0-9]{${PIN_LENGTH}}$`), `Enter your ${PIN_LENGTH}-digit PIN.`);

/** A new PIN: 6 digits and not an obvious one. */
export const newPinSchema = z
  .string()
  .regex(new RegExp(`^[0-9]{${PIN_LENGTH}}$`), `Use exactly ${PIN_LENGTH} digits.`)
  .refine((pin) => !isWeakPin(pin), "Choose a PIN that is harder to guess, not 111111 or 123456.");

function scryptAsync(input: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(input, salt, HASH_BYTES, SCRYPT_OPTIONS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function peppered(pin: string, keyVersion: number): Buffer {
  return createHmac("sha256", derivePiiSubkey(PEPPER_PURPOSE, keyVersion)).update(pin).digest();
}

function assertPinShape(pin: string): void {
  if (typeof pin !== "string" || !new RegExp(`^[0-9]{${PIN_LENGTH}}$`).test(pin)) {
    throw new TypeError(`A PIN is exactly ${PIN_LENGTH} digits.`);
  }
}

/** Hashes a PIN for private.worker_pins. Throws PiiKeyError when the key is not configured. */
export async function hashPin(pin: string): Promise<string> {
  assertPinShape(pin);
  const salt = randomBytes(SALT_BYTES);
  const hash = await scryptAsync(peppered(pin, PII_KEY_VERSION), salt);
  return `${FORMAT}$k${PII_KEY_VERSION}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

let dummy: Promise<string> | null = null;

/** A real hash of a random PIN, made once, to check against when there is no stored hash. */
function dummyHash(): Promise<string> {
  dummy ??= hashPin(String(randomBytes(4).readUInt32BE() % 10 ** PIN_LENGTH).padStart(6, "0"));
  return dummy;
}

/**
 * True when `pin` matches `stored`. With no stored hash (an unknown company code or staff ID)
 * or a malformed one, the PIN is still checked against a dummy hash and the answer is false,
 * so both cases take the same time as a real check.
 */
export async function verifyPin(pin: string, stored: string | null | undefined): Promise<boolean> {
  const parsed = stored ? STORED.exec(stored) : null;
  const target = parsed ? stored! : await dummyHash();
  const [, version, salt, expected] = STORED.exec(target) ?? [];
  if (!version || !salt || !expected) return false;
  const shapeOk = typeof pin === "string" && new RegExp(`^[0-9]{${PIN_LENGTH}}$`).test(pin);
  const actual = await scryptAsync(
    peppered(shapeOk ? pin : "000000", Number(version)),
    Buffer.from(salt, "base64url"),
  );
  const match = timingSafeEqual(actual, Buffer.from(expected, "base64url"));
  return parsed !== null && shapeOk && match;
}
