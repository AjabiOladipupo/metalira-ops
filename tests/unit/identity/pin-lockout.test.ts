/**
 * Slice 1.11 (owner decision 18): lockout counting, the hold after 3 lockouts in 24 hours, and
 * the company cap on wrong PINs, through checkWorkerPin. The store here is an in-memory copy of
 * public.worker_sign_in_begin / finish (migration 20261117180000) built from the constants in
 * src/lib/pin-lockout.ts; tests/rls/pin-lockout.test.ts checks the real functions, and the last
 * block checks the migration uses the same numbers.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import {
  COMPANY_WINDOW_MINUTES,
  COMPANY_WRONG_PIN_CAP,
  IP_ATTEMPT_LIMIT,
  PIN_HOLD_AFTER_LOCKOUTS,
  PIN_HOLD_WINDOW_HOURS,
  PIN_LOCK_MINUTES,
  PIN_MAX_ATTEMPTS,
  signInState,
} from "@/lib/pin-lockout";
import {
  checkWorkerPin,
  ipKey,
  workerSignInSchema,
  type BeginResult,
  type FinishOutcome,
  type WorkerSignInStore,
} from "@/server/identity/worker-sign-in";

vi.stubEnv("PII_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
afterAll(() => {
  vi.unstubAllEnvs();
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const RIGHT = "482913";
const WRONG = "000111";
const NETWORK = ipKey("10.0.0.1");

interface Cred {
  attempts: number;
  lockedUntil: number | null;
  heldAt: number | null;
  /** Times the worker was locked (the worker_auth.locked audit rows). */
  lockouts: number[];
  pinSetAt: number;
}

/**
 * The database rules in memory. `known` maps a staff ID (lower case) to its PIN; any other
 * staff ID in the company has no login and is counted through the same rules, as
 * private.auth_throttle does.
 */
function companyStore(known: Record<string, string>) {
  let now = 0;
  const creds = new Map<string, Cred>();
  let company = { attempts: 0, windowStart: 0 };
  let throttledAudits = 0;

  const cred = (staff: string): Cred => {
    let c = creds.get(staff);
    if (!c) {
      c = { attempts: 0, lockedUntil: null, heldAt: null, lockouts: [], pinSetAt: 0 };
      creds.set(staff, c);
    }
    return c;
  };
  const recentLockouts = (c: Cred) =>
    c.lockouts.filter((t) => t > Math.max(now - PIN_HOLD_WINDOW_HOURS * HOUR, c.pinSetAt)).length;

  const store: WorkerSignInStore = {
    async begin(_code, staffId): Promise<BeginResult> {
      // Every try takes a moment, as in the database (now() moves between transactions).
      now += 1;
      if (now - company.windowStart >= COMPANY_WINDOW_MINUTES * MINUTE) {
        company = { attempts: 0, windowStart: now };
      }
      if (company.attempts >= COMPANY_WRONG_PIN_CAP) {
        if (company.attempts === COMPANY_WRONG_PIN_CAP) throttledAudits += 1;
        return { outcome: "company_throttled" };
      }
      const staff = staffId.toLowerCase();
      const c = cred(staff);
      if (c.heldAt !== null) return { outcome: "held" };
      if (c.lockedUntil !== null && c.lockedUntil > now) return { outcome: "locked" };
      if (c.lockedUntil !== null) Object.assign(c, { attempts: 0, lockedUntil: null });
      c.attempts += 1;
      const locks = c.attempts >= PIN_MAX_ATTEMPTS;
      if (locks) c.lockedUntil = now + PIN_LOCK_MINUTES * MINUTE;
      company.attempts += 1;
      const isKnown = staff in known;
      const holds = locks && recentLockouts(c) + 1 >= PIN_HOLD_AFTER_LOCKOUTS;
      if (!isKnown && locks) {
        // No login: the try always fails, so the lock (and hold) is recorded now.
        c.lockouts.push(now);
        if (holds) c.heldAt = now;
      }
      return {
        outcome: "proceed",
        login: isKnown ? { workerId: staff, organisationId: "o-1", authUserId: `u-${staff}` } : null,
        pinHash: isKnown ? (known[staff] ?? null) : null,
        locksOnFailure: locks,
        holdsOnFailure: holds,
      };
    },
    async finish(workerId, ok): Promise<FinishOutcome> {
      if (workerId === null) return "failed";
      const c = cred(workerId);
      if (ok) {
        Object.assign(c, { attempts: 0, lockedUntil: null });
        company.attempts = Math.max(company.attempts - 1, 0);
        return "signed_in";
      }
      if (c.heldAt !== null) return "held";
      if (c.lockedUntil !== null && c.lockedUntil > now) {
        c.lockouts.push(now);
        if (recentLockouts(c) >= PIN_HOLD_AFTER_LOCKOUTS) {
          c.heldAt = now;
          return "held";
        }
        return "locked";
      }
      return "failed";
    },
  };
  return {
    store,
    advance: (ms: number) => {
      now += ms;
    },
    unlock: (staff: string) => {
      const c = cred(staff);
      if (c.heldAt !== null) throw new Error("held: needs a new PIN");
      Object.assign(c, { attempts: 0, lockedUntil: null });
    },
    newPin: (staff: string) => {
      Object.assign(cred(staff), { attempts: 0, lockedUntil: null, heldAt: null, pinSetAt: now });
    },
    throttledAudits: () => throttledAudits,
  };
}

const verify = async (pin: string, hash: string | null) => hash !== null && pin === hash;
const input = (pin: string, staffId = "EMP-0001") =>
  workerSignInSchema.parse({ companyCode: "K7PQ2M", staffId, pin });

async function lockOnce(store: WorkerSignInStore, staffId = "EMP-0001") {
  const out: string[] = [];
  for (let i = 0; i < PIN_MAX_ATTEMPTS; i += 1) {
    out.push((await checkWorkerPin(store, input(WRONG, staffId), NETWORK, verify)).status);
  }
  return out.at(-1);
}

describe("lockout counting and the hold (decision 18)", () => {
  it("holds sign-in at the 3rd lockout within 24 hours, even after the locks run out", async () => {
    const s = companyStore({ "emp-0001": RIGHT });
    expect(await lockOnce(s.store)).toBe("locked");
    s.advance(PIN_LOCK_MINUTES * MINUTE + 1);
    expect(await lockOnce(s.store)).toBe("locked");
    s.advance(PIN_LOCK_MINUTES * MINUTE + 1);
    expect(await lockOnce(s.store)).toBe("held");
    // The right PIN, a day later, is still refused: only a new PIN lifts a hold.
    s.advance(25 * HOUR);
    expect((await checkWorkerPin(s.store, input(RIGHT), NETWORK, verify)).status).toBe("held");
    s.newPin("emp-0001");
    expect((await checkWorkerPin(s.store, input(RIGHT), NETWORK, verify)).status).toBe(
      "signed_in",
    );
  });

  it("forgets lockouts older than 24 hours", async () => {
    const s = companyStore({ "emp-0001": RIGHT });
    expect(await lockOnce(s.store)).toBe("locked");
    s.advance(PIN_LOCK_MINUTES * MINUTE + 1);
    expect(await lockOnce(s.store)).toBe("locked");
    s.advance(PIN_HOLD_WINDOW_HOURS * HOUR);
    expect(await lockOnce(s.store)).toBe("locked");
  });

  it("a manager unlock lifts a lock but does not reset the count", async () => {
    const s = companyStore({ "emp-0001": RIGHT });
    expect(await lockOnce(s.store)).toBe("locked");
    s.unlock("emp-0001");
    expect(await lockOnce(s.store)).toBe("locked");
    s.unlock("emp-0001");
    expect(await lockOnce(s.store)).toBe("held");
    expect(() => s.unlock("emp-0001")).toThrow(/new PIN/);
  });

  it("a new PIN starts the count again", async () => {
    const s = companyStore({ "emp-0001": RIGHT });
    await lockOnce(s.store);
    s.unlock("emp-0001");
    await lockOnce(s.store);
    s.newPin("emp-0001");
    expect(await lockOnce(s.store)).toBe("locked");
  });

  it("answers an unknown staff ID exactly like a real one, hold included", async () => {
    const real = companyStore({ "emp-0001": RIGHT });
    const unknown = companyStore({});
    const run = async (s: ReturnType<typeof companyStore>, staffId: string) => {
      const out: (string | undefined)[] = [];
      for (let round = 0; round < 3; round += 1) {
        out.push(await lockOnce(s.store, staffId));
        s.advance(PIN_LOCK_MINUTES * MINUTE + 1);
      }
      out.push((await checkWorkerPin(s.store, input(WRONG, staffId), NETWORK, verify)).status);
      return out;
    };
    const fromReal = await run(real, "EMP-0001");
    expect(fromReal).toEqual(["locked", "locked", "held", "held"]);
    expect(await run(unknown, "EMP-9999")).toEqual(fromReal);
  });
});

describe("company cap on wrong PINs (decision 18)", () => {
  it("stops sign-ins for the company at the cap without counting against any worker", async () => {
    const s = companyStore({ "emp-0001": RIGHT });
    // A spray: one wrong PIN for each of many staff IDs.
    for (let i = 0; i < COMPANY_WRONG_PIN_CAP; i += 1) {
      const result = await checkWorkerPin(s.store, input(WRONG, `EMP-${1000 + i}`), NETWORK, verify);
      expect(result.status).toBe("invalid");
    }
    const refused = await checkWorkerPin(s.store, input(RIGHT), NETWORK, verify);
    expect(refused.status).toBe("company_throttled");
    // Nobody was locked by the refusals: after the window the real worker signs in.
    for (let i = 0; i < 20; i += 1) await checkWorkerPin(s.store, input(WRONG), NETWORK, verify);
    s.advance(COMPANY_WINDOW_MINUTES * MINUTE);
    expect((await checkWorkerPin(s.store, input(RIGHT), NETWORK, verify)).status).toBe(
      "signed_in",
    );
  });

  it("gives a successful sign-in its try back", async () => {
    const s = companyStore({ "emp-0001": RIGHT });
    for (let i = 0; i < COMPANY_WRONG_PIN_CAP - 1; i += 1) {
      await checkWorkerPin(s.store, input(WRONG, `EMP-${2000 + i}`), NETWORK, verify);
    }
    for (let i = 0; i < 10; i += 1) {
      expect((await checkWorkerPin(s.store, input(RIGHT), NETWORK, verify)).status).toBe(
        "signed_in",
      );
    }
  });

  it("caps a spray far below what per-worker locks alone allow", () => {
    const workers = 500;
    const withoutCap = workers * PIN_MAX_ATTEMPTS;
    expect(COMPANY_WRONG_PIN_CAP).toBeLessThan(withoutCap / 10);
    // Each window can push at most cap / 5 workers into a lock, so a hold needs many windows.
    expect(Math.floor(COMPANY_WRONG_PIN_CAP / PIN_MAX_ATTEMPTS / PIN_HOLD_AFTER_LOCKOUTS)).toBe(3);
    // And it stays under the per-network cap, so one network can't use it all up unnoticed.
    expect(COMPANY_WRONG_PIN_CAP).toBeLessThan(IP_ATTEMPT_LIMIT);
  });
});

describe("signInState", () => {
  const base = {
    pinSetAt: "2026-11-17T08:00:00Z",
    lastSignInAt: null,
    failedAttempts: 0,
    lockedUntil: null,
    heldAt: null,
  };
  const now = new Date("2026-11-17T10:00:00Z");

  it("reads no login, open, locked and held", () => {
    expect(signInState(null, now)).toEqual({ kind: "no_login" });
    expect(signInState({ ...base, failedAttempts: 2 }, now)).toEqual({
      kind: "open",
      failedAttempts: 2,
    });
    expect(signInState({ ...base, lockedUntil: "2026-11-17T10:10:00Z" }, now)).toEqual({
      kind: "locked",
      until: "2026-11-17T10:10:00Z",
    });
    expect(
      signInState({ ...base, lockedUntil: "2026-11-17T10:10:00Z", heldAt: "2026-11-17T09:55:00Z" }, now),
    ).toEqual({ kind: "held", since: "2026-11-17T09:55:00Z" });
  });

  it("treats a lock that has run out as open with a clean count", () => {
    expect(
      signInState({ ...base, failedAttempts: 5, lockedUntil: "2026-11-17T09:00:00Z" }, now),
    ).toEqual({ kind: "open", failedAttempts: 0 });
  });
});

describe("the migration enforces the same numbers", () => {
  const sql = readFileSync(
    path.join(process.cwd(), "supabase/migrations/20261117180000_pin_lockout_staff_id.sql"),
    "utf8",
  );
  const constant = (name: string) =>
    new RegExp(`${name} constant (integer|interval) := (interval ')?([0-9]+)`).exec(sql)?.[3];

  it("matches src/lib/pin-lockout.ts", () => {
    expect(Number(constant("max_attempts"))).toBe(PIN_MAX_ATTEMPTS);
    expect(Number(constant("lock_for"))).toBe(PIN_LOCK_MINUTES);
    expect(Number(constant("hold_after_lockouts"))).toBe(PIN_HOLD_AFTER_LOCKOUTS);
    expect(Number(constant("hold_window"))).toBe(PIN_HOLD_WINDOW_HOURS);
    expect(Number(constant("ip_limit"))).toBe(IP_ATTEMPT_LIMIT);
    expect(Number(constant("company_wrong_pin_cap"))).toBe(COMPANY_WRONG_PIN_CAP);
    expect(Number(constant("company_window"))).toBe(COMPANY_WINDOW_MINUTES);
    expect(sql).toContain("interval '24 hours'");
  });
});
