/**
 * Slice 1.9: the PIN sign-in flow around the database's attempt counter. The store here mirrors
 * public.worker_sign_in_begin / finish (5 tries, then a 15-minute lock, counted before the PIN
 * is checked); tests/rls/worker-auth.test.ts checks the real functions.
 */
import { randomBytes } from "node:crypto";

import { afterAll, describe, expect, it, vi } from "vitest";

import {
  checkWorkerPin,
  clientIp,
  ipKey,
  workerSignInSchema,
  type BeginResult,
  type WorkerSignInStore,
} from "@/server/identity/worker-sign-in";

// ipKey is keyed from the personal data key: a throwaway one for these tests.
vi.stubEnv("PII_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
afterAll(() => {
  vi.unstubAllEnvs();
});

const LOGIN = { workerId: "w-1", organisationId: "o-1", authUserId: "u-1" };
const RIGHT = "482913";
const NETWORK = ipKey("10.0.0.1");

/** In-memory copy of the database rules, with a clock the test moves. */
function fakeStore(known: Record<string, string>) {
  let now = 0;
  const counters = new Map<string, { attempts: number; lockedUntil: number | null }>();
  const finishes: { workerId: string | null; ok: boolean }[] = [];
  const store: WorkerSignInStore = {
    async begin(companyCode, staffId) {
      const key = `${companyCode}|${staffId.toLowerCase()}`;
      const c = counters.get(key) ?? { attempts: 0, lockedUntil: null };
      if (c.lockedUntil !== null && c.lockedUntil > now) return { outcome: "locked" };
      if (c.lockedUntil !== null) Object.assign(c, { attempts: 0, lockedUntil: null });
      c.attempts += 1;
      if (c.attempts >= 5) c.lockedUntil = now + 15 * 60_000;
      counters.set(key, c);
      const isKnown = key in known;
      return {
        outcome: "proceed",
        login: isKnown ? LOGIN : null,
        pinHash: isKnown ? (known[key] ?? null) : null,
        locksOnFailure: c.lockedUntil !== null,
        holdsOnFailure: false,
      } satisfies BeginResult;
    },
    async finish(workerId, ok) {
      finishes.push({ workerId, ok });
      if (workerId === null) return "failed";
      const key = Object.keys(known)[0]!;
      const c = counters.get(key)!;
      if (ok) {
        Object.assign(c, { attempts: 0, lockedUntil: null });
        return "signed_in";
      }
      return c.lockedUntil !== null && c.lockedUntil > now ? "locked" : "failed";
    },
  };
  return {
    store,
    finishes,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

// The "hash" in these tests is the PIN itself; real hashing is covered in worker-pin.test.ts.
const verify = async (pin: string, hash: string | null) => hash !== null && pin === hash;

const input = (pin: string, staffId = "EMP-0001", companyCode = "K7PQ2M") =>
  workerSignInSchema.parse({ companyCode, staffId, pin });

describe("checkWorkerPin", () => {
  it("signs in with the right PIN", async () => {
    const { store } = fakeStore({ "K7PQ2M|emp-0001": RIGHT });
    expect(await checkWorkerPin(store, input(RIGHT), NETWORK, verify)).toEqual({
      status: "signed_in",
      ...LOGIN,
    });
  });

  it("locks on the 5th wrong PIN and refuses even the right PIN for 15 minutes", async () => {
    const { store, advance } = fakeStore({ "K7PQ2M|emp-0001": RIGHT });
    for (let i = 1; i <= 4; i += 1) {
      expect(await checkWorkerPin(store, input("000111"), NETWORK, verify)).toEqual({
        status: "invalid",
      });
    }
    expect(await checkWorkerPin(store, input("000111"), NETWORK, verify)).toEqual({
      status: "locked",
    });
    expect(await checkWorkerPin(store, input(RIGHT), NETWORK, verify)).toEqual({
      status: "locked",
    });
    advance(14 * 60_000);
    expect((await checkWorkerPin(store, input(RIGHT), NETWORK, verify)).status).toBe("locked");
    advance(60_000 + 1);
    expect((await checkWorkerPin(store, input(RIGHT), NETWORK, verify)).status).toBe("signed_in");
  });

  it("a right PIN on the 5th try still signs in, and resets the count", async () => {
    const { store } = fakeStore({ "K7PQ2M|emp-0001": RIGHT });
    for (let i = 1; i <= 4; i += 1) await checkWorkerPin(store, input("000111"), NETWORK, verify);
    expect((await checkWorkerPin(store, input(RIGHT), NETWORK, verify)).status).toBe("signed_in");
    for (let i = 1; i <= 4; i += 1) {
      expect((await checkWorkerPin(store, input("000111"), NETWORK, verify)).status).toBe(
        "invalid",
      );
    }
  });

  it("answers an unknown company code or staff ID exactly like a wrong PIN, lock included", async () => {
    const real = fakeStore({ "K7PQ2M|emp-0001": RIGHT });
    const unknown = fakeStore({});
    const answers = async (s: WorkerSignInStore, staffId: string) => {
      const out: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        out.push((await checkWorkerPin(s, input("000111", staffId), NETWORK, verify)).status);
      }
      return out;
    };
    const fromReal = await answers(real.store, "EMP-0001");
    const fromUnknown = await answers(unknown.store, "EMP-9999");
    expect(fromUnknown).toEqual(fromReal);
    expect(fromReal).toEqual(["invalid", "invalid", "invalid", "invalid", "locked", "locked"]);
  });

  it("checks a PIN and records a result on the unknown path too", async () => {
    const { store, finishes } = fakeStore({});
    const spy = vi.fn(verify);
    await checkWorkerPin(store, input(RIGHT, "EMP-9999"), NETWORK, spy);
    expect(spy).toHaveBeenCalledWith(RIGHT, null);
    expect(finishes).toEqual([{ workerId: null, ok: false }]);
  });

  it("never reports success for an unknown pair, whatever the verifier says", async () => {
    const { store } = fakeStore({});
    const result = await checkWorkerPin(store, input(RIGHT, "EMP-9999"), NETWORK, async () => true);
    expect(result.status).toBe("invalid");
  });

  it("refuses without checking the PIN when the network is blocked", async () => {
    const spy = vi.fn(verify);
    const store: WorkerSignInStore = {
      begin: async () => ({ outcome: "ip_blocked" }),
      finish: async () => "failed",
    };
    expect(await checkWorkerPin(store, input(RIGHT), NETWORK, spy)).toEqual({
      status: "ip_blocked",
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("workerSignInSchema", () => {
  it("trims and upper-cases the company code and trims the staff ID", () => {
    expect(
      workerSignInSchema.parse({ companyCode: " k7pq2m ", staffId: " emp-1 ", pin: RIGHT }),
    ).toEqual({ companyCode: "K7PQ2M", staffId: "emp-1", pin: RIGHT });
  });

  it("asks for each field, and for a 6-digit PIN", () => {
    const result = workerSignInSchema.safeParse({ companyCode: "", staffId: "", pin: "12" });
    expect(result.success).toBe(false);
    const fields = result.error!.issues.map((issue) => issue.path[0]);
    expect(fields).toEqual(expect.arrayContaining(["companyCode", "staffId", "pin"]));
  });
});

describe("network key", () => {
  it("keys the address with a server secret, never keeping it", () => {
    expect(ipKey("102.89.1.7")).toMatch(/^[0-9a-f]{64}$/);
    expect(ipKey("102.89.1.7")).not.toContain("102");
    expect(ipKey("102.89.1.7")).toBe(ipKey(" 102.89.1.7 "));
    expect(ipKey("102.89.1.7")).not.toBe(ipKey("102.89.1.8"));
    expect(ipKey(null)).toBe(ipKey(undefined));
    const before = ipKey("102.89.1.7");
    vi.stubEnv("PII_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    expect(ipKey("102.89.1.7")).not.toBe(before);
  });

  it("reads the platform's client address headers", () => {
    const headers = (values: Record<string, string>) => ({
      get: (name: string) => values[name] ?? null,
    });
    expect(clientIp(headers({ "x-real-ip": "102.89.1.7", "x-forwarded-for": "1.1.1.1" }))).toBe(
      "102.89.1.7",
    );
    // Never x-forwarded-for, which the client controls (CLAUDE.md).
    expect(clientIp(headers({ "x-forwarded-for": "102.89.1.7, 10.0.0.1" }))).toBeNull();
    expect(clientIp(headers({}))).toBeNull();
  });
});
