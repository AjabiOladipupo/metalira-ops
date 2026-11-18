/**
 * Slice 1.11 (owner decision 18): lockout counting, the hold after 3 lockouts in 24 hours, and
 * the caps on wrong PINs (per company and per network address), through checkWorkerPin. The
 * store here is an in-memory copy of public.worker_sign_in_begin / finish (migration
 * 20261117180000) built from the constants in src/lib/pin-lockout.ts; tests/rls/pin-lockout.test.ts
 * checks the real functions, and the last block checks the migration uses the same numbers.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import {
  COMPANY_WINDOW_MINUTES,
  COMPANY_WRONG_PIN_CAP,
  IP_ATTEMPT_LIMIT,
  IP_WRONG_PIN_CAP,
  PIN_HOLD_AFTER_LOCKOUTS,
  PIN_HOLD_WINDOW_HOURS,
  PIN_LOCK_MINUTES,
  PIN_MAX_ATTEMPTS,
  signInState,
} from "@/lib/pin-lockout";
import {
  checkWorkerPin,
  clientIp,
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
const WINDOW = COMPANY_WINDOW_MINUTES * MINUTE;
const RIGHT = "482913";
const WRONG = "000111";
const NETWORK = ipKey("10.0.0.1");
let networkCounter = 0;
/** A fresh network address, so the per-network cap stays out of a test's way. */
const freshNetwork = () =>
  ipKey(`10.1.${Math.floor(networkCounter / 250)}.${networkCounter++ % 250}`);

interface Cred {
  attempts: number;
  lockedUntil: number | null;
  heldAt: number | null;
  /** Times the worker was locked (the worker_auth.locked audit rows). */
  lockouts: number[];
  pinSetAt: number;
}

interface Counter {
  wrong: number;
  windowStart: number;
}

/**
 * The database rules in memory. `known` maps a staff ID (lower case) to its PIN; any other
 * staff ID in the company has no login and is counted through the same rules, as
 * private.auth_throttle does. Only wrong PINs count against the company and the network, and a
 * success gives nothing back.
 */
function companyStore(known: Record<string, string>) {
  let now = 0;
  const creds = new Map<string, Cred>();
  let company: Counter & { cappedAt: number | null } = { wrong: 0, windowStart: 0, cappedAt: null };
  const cappedWindows: [number, number][] = [];
  const networks = new Map<string, Counter>();
  let alerts = 0;

  const cred = (staff: string): Cred => {
    let c = creds.get(staff);
    if (!c) {
      c = { attempts: 0, lockedUntil: null, heldAt: null, lockouts: [], pinSetAt: -1 };
      creds.set(staff, c);
    }
    return c;
  };
  const inCapped = (t: number) => cappedWindows.some(([from, to]) => t >= from && t < to);
  const recentLockouts = (c: Cred) =>
    c.lockouts.filter(
      (t) => t > Math.max(now - PIN_HOLD_WINDOW_HOURS * HOUR, c.pinSetAt) && !inCapped(t),
    ).length;
  const network = (key: string): Counter => {
    let n = networks.get(key);
    if (!n || now - n.windowStart >= WINDOW) {
      n = { wrong: 0, windowStart: now };
      networks.set(key, n);
    }
    return n;
  };
  const countWrong = (key: string) => {
    if (now - company.windowStart >= WINDOW)
      company = { wrong: 0, windowStart: now, cappedAt: null };
    company.wrong += 1;
    network(key).wrong += 1;
  };

  const store: WorkerSignInStore = {
    async begin(_code, staffId, key): Promise<BeginResult> {
      // Every try takes a moment, as in the database (now() moves between transactions).
      now += 1;
      if (network(key).wrong >= IP_WRONG_PIN_CAP) return { outcome: "ip_blocked" };
      if (now - company.windowStart >= WINDOW)
        company = { wrong: 0, windowStart: now, cappedAt: null };
      if (company.wrong >= COMPANY_WRONG_PIN_CAP) {
        const first = company.cappedAt === null;
        if (first) {
          company.cappedAt = now;
          cappedWindows.push([company.windowStart, company.windowStart + WINDOW]);
          alerts += 1;
        }
        return { outcome: "company_throttled", alertOrganisationId: first ? "o-1" : null };
      }
      const staff = staffId.toLowerCase();
      const c = cred(staff);
      if (c.heldAt !== null) return { outcome: "held" };
      if (c.lockedUntil !== null && c.lockedUntil > now) return { outcome: "locked" };
      if (c.lockedUntil !== null) Object.assign(c, { attempts: 0, lockedUntil: null });
      c.attempts += 1;
      const locks = c.attempts >= PIN_MAX_ATTEMPTS;
      if (locks) c.lockedUntil = now + PIN_LOCK_MINUTES * MINUTE;
      const isKnown = staff in known;
      const holds = locks && !inCapped(now) && recentLockouts(c) + 1 >= PIN_HOLD_AFTER_LOCKOUTS;
      if (!isKnown) {
        // No login: the try always fails, so the wrong PIN, lock and hold are recorded now.
        if (locks) {
          c.lockouts.push(now);
          if (holds) c.heldAt = now;
        }
        countWrong(key);
      }
      return {
        outcome: "proceed",
        login: isKnown
          ? { workerId: staff, organisationId: "o-1", authUserId: `u-${staff}` }
          : null,
        pinHash: isKnown ? (known[staff] ?? null) : null,
        locksOnFailure: locks,
        holdsOnFailure: holds,
      };
    },
    async finish(workerId, ok, key): Promise<FinishOutcome> {
      if (workerId === null) return "failed";
      const c = cred(workerId);
      if (ok) {
        Object.assign(c, { attempts: 0, lockedUntil: null });
        return "signed_in";
      }
      countWrong(key);
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
    alerts: () => alerts,
  };
}

const verify = async (pin: string, hash: string | null) => hash !== null && pin === hash;
const input = (pin: string, staffId = "EMP-0001") =>
  workerSignInSchema.parse({ companyCode: "K7PQ2M", staffId, pin });

async function lockOnce(store: WorkerSignInStore, staffId = "EMP-0001", net = NETWORK) {
  const out: string[] = [];
  for (let i = 0; i < PIN_MAX_ATTEMPTS; i += 1) {
    out.push((await checkWorkerPin(store, input(WRONG, staffId), net, verify)).status);
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
    expect((await checkWorkerPin(s.store, input(RIGHT), NETWORK, verify)).status).toBe("signed_in");
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
    expect(await lockOnce(s.store, "EMP-0001", freshNetwork())).toBe("locked");
    s.unlock("emp-0001");
    expect(await lockOnce(s.store, "EMP-0001", freshNetwork())).toBe("locked");
    s.unlock("emp-0001");
    expect(await lockOnce(s.store, "EMP-0001", freshNetwork())).toBe("held");
    expect(() => s.unlock("emp-0001")).toThrow(/new PIN/);
  });

  it("a new PIN starts the count again", async () => {
    const s = companyStore({ "emp-0001": RIGHT });
    await lockOnce(s.store, "EMP-0001", freshNetwork());
    s.unlock("emp-0001");
    await lockOnce(s.store, "EMP-0001", freshNetwork());
    s.newPin("emp-0001");
    expect(await lockOnce(s.store, "EMP-0001", freshNetwork())).toBe("locked");
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

  it("records a failed try when the PIN check itself breaks, so the lock still counts", async () => {
    const s = companyStore({ "emp-0001": RIGHT });
    for (let i = 0; i < PIN_MAX_ATTEMPTS - 1; i += 1) {
      await checkWorkerPin(s.store, input(WRONG), NETWORK, verify);
    }
    const broken = async () => {
      throw new Error("scrypt failed");
    };
    await expect(checkWorkerPin(s.store, input(WRONG), NETWORK, broken)).rejects.toThrow();
    expect((await checkWorkerPin(s.store, input(RIGHT), NETWORK, verify)).status).toBe("locked");
  });
});

describe("caps on wrong PINs (decision 18)", () => {
  it("stops sign-ins for the company at the cap without counting against any worker", async () => {
    const s = companyStore({ "emp-0001": RIGHT });
    // A spray from many networks: one wrong PIN for each of many staff IDs.
    for (let i = 0; i < COMPANY_WRONG_PIN_CAP; i += 1) {
      const result = await checkWorkerPin(
        s.store,
        input(WRONG, `EMP-${1000 + i}`),
        freshNetwork(),
        verify,
      );
      expect(result.status).toBe("invalid");
    }
    const refused = await checkWorkerPin(s.store, input(RIGHT), freshNetwork(), verify);
    expect(refused).toEqual({ status: "company_throttled", alertOrganisationId: "o-1" });
    // Nobody was locked by the refusals: after the window the real worker signs in.
    for (let i = 0; i < 20; i += 1) {
      const again = await checkWorkerPin(s.store, input(WRONG), freshNetwork(), verify);
      // Only the first refusal of the window asks for the owner and HR alert.
      expect(again).toEqual({ status: "company_throttled", alertOrganisationId: null });
    }
    expect(s.alerts()).toBe(1);
    s.advance(WINDOW);
    expect((await checkWorkerPin(s.store, input(RIGHT), NETWORK, verify)).status).toBe("signed_in");
  });

  it("sends one alert per window, however long the attack lasts", async () => {
    const s = companyStore({});
    for (let window = 0; window < 3; window += 1) {
      for (let i = 0; i < COMPANY_WRONG_PIN_CAP + 30; i += 1) {
        await checkWorkerPin(s.store, input(WRONG, `EMP-${window}-${i}`), freshNetwork(), verify);
      }
      s.advance(WINDOW);
    }
    expect(s.alerts()).toBe(3);
  });

  it("successes give nothing back: a valid login can't reset the company counter", async () => {
    const s = companyStore({ "emp-0001": RIGHT });
    let wrong = 0;
    for (let round = 0; round < 40; round += 1) {
      for (let i = 0; i < 2; i += 1) {
        const r = await checkWorkerPin(
          s.store,
          input(WRONG, `EMP-${round}-${i}`),
          freshNetwork(),
          verify,
        );
        if (r.status === "invalid") wrong += 1;
      }
      await checkWorkerPin(s.store, input(RIGHT), freshNetwork(), verify);
    }
    expect(wrong).toBe(COMPANY_WRONG_PIN_CAP);
  });

  it("caps wrong PINs from one network well below the company cap", async () => {
    const s = companyStore({ "emp-0001": RIGHT });
    const net = ipKey("102.89.1.7");
    const answers: string[] = [];
    for (let i = 0; i < COMPANY_WRONG_PIN_CAP; i += 1) {
      answers.push(
        (await checkWorkerPin(s.store, input(WRONG, `EMP-${3000 + i}`), net, verify)).status,
      );
    }
    expect(answers.filter((a) => a === "invalid")).toHaveLength(IP_WRONG_PIN_CAP);
    expect(answers.at(-1)).toBe("ip_blocked");
    // The company was not capped by one network, so others still sign in.
    expect((await checkWorkerPin(s.store, input(RIGHT), freshNetwork(), verify)).status).toBe(
      "signed_in",
    );
  });

  it("lockouts in a window the company capped don't count towards a hold", async () => {
    const s = companyStore({ "emp-0001": RIGHT });
    // Two lockouts in one window (a manager unlocks in between)...
    expect(await lockOnce(s.store, "EMP-0001", freshNetwork())).toBe("locked");
    s.unlock("emp-0001");
    expect(await lockOnce(s.store, "EMP-0001", freshNetwork())).toBe("locked");
    s.unlock("emp-0001");
    // ...in a window a flood then caps.
    for (let i = 0; i <= COMPANY_WRONG_PIN_CAP; i += 1) {
      await checkWorkerPin(s.store, input(WRONG, `FLOOD-${i}`), freshNetwork(), verify);
    }
    expect(s.alerts()).toBe(1);
    s.advance(WINDOW);
    // The third lockout of the day is the first that counts.
    expect(await lockOnce(s.store, "EMP-0001", freshNetwork())).toBe("locked");
  });

  it("keeps the numbers in proportion", () => {
    const workers = 500;
    expect(COMPANY_WRONG_PIN_CAP).toBeLessThan((workers * PIN_MAX_ATTEMPTS) / 10);
    expect(IP_WRONG_PIN_CAP * 3).toBeLessThanOrEqual(COMPANY_WRONG_PIN_CAP);
    expect(COMPANY_WRONG_PIN_CAP).toBeLessThan(IP_ATTEMPT_LIMIT);
  });

  it("reads the client address only from x-real-ip, never x-forwarded-for", () => {
    const headers = (values: Record<string, string>) => ({
      get: (name: string) => values[name] ?? null,
    });
    expect(clientIp(headers({ "x-real-ip": "102.89.1.7", "x-forwarded-for": "1.1.1.1" }))).toBe(
      "102.89.1.7",
    );
    expect(clientIp(headers({ "x-forwarded-for": "102.89.1.7" }))).toBeNull();
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
      signInState(
        { ...base, lockedUntil: "2026-11-17T10:10:00Z", heldAt: "2026-11-17T09:55:00Z" },
        now,
      ),
    ).toEqual({ kind: "held", since: "2026-11-17T09:55:00Z" });
  });

  it("treats a lock that has run out as open with a clean count, and a line manager's view", () => {
    expect(
      signInState({ ...base, failedAttempts: 5, lockedUntil: "2026-11-17T09:00:00Z" }, now),
    ).toEqual({ kind: "open", failedAttempts: 0 });
    expect(signInState({ ...base, pinSetAt: null, failedAttempts: null }, now)).toEqual({
      kind: "open",
      failedAttempts: 0,
    });
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
    expect(Number(constant("ip_wrong_pin_cap"))).toBe(IP_WRONG_PIN_CAP);
    expect(Number(constant("company_wrong_pin_cap"))).toBe(COMPANY_WRONG_PIN_CAP);
    expect(Number(constant("company_window"))).toBe(COMPANY_WINDOW_MINUTES);
    expect(sql).toContain("interval '24 hours'");
    // Successes refund nothing.
    expect(sql).not.toMatch(/attempts = greatest\(a\.attempts - 1, 0\)/);
  });
});
