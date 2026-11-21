/**
 * Slice 3.4: the offline queue (Dexie on fake-indexeddb), its backoff and the sync engine with
 * fake senders: success, transient failure, permanent failure, a crash mid-send, a wrong
 * session, one queue per worker and organisation, and the retention limits.
 */
import "fake-indexeddb/auto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, backoffDelay } from "@/lib/offline/backoff";
import Dexie from "dexie";

import { deleteQueueDb, ownerFromDbName, QueueDb, queueDb, queueDbName } from "@/lib/offline/db";
import {
  countPending,
  countUnsent,
  enqueue,
  sendTiming,
  type QueueClock,
} from "@/lib/offline/queue";
import { housekeepQueues } from "@/lib/offline/retention";
import { isStorageLow } from "@/lib/offline/storage";
import {
  drainQueue,
  pruneQueue,
  SyncEngine,
  type SyncEnvironment,
} from "@/lib/offline/sync-engine";
import {
  FAILED_RETENTION_MS,
  toErrorCode,
  UNSENT_MAX_AGE_MS,
  type AnyQueueItem,
  type QueueOwner,
  type QueueSender,
  type SendResult,
} from "@/lib/offline/types";

const ORG_A = "0b6f8a8e-2c4e-4d4f-9a39-0d6a2f2b8a01";
const ORG_B = "0b6f8a8e-2c4e-4d4f-9a39-0d6a2f2b8a02";
const WORKER_1 = "6f1c3a52-9b0e-4c7e-8d0a-4d8f7c6b5a01";
const WORKER_2 = "6f1c3a52-9b0e-4c7e-8d0a-4d8f7c6b5a02";

const owners: QueueOwner[] = [];
function owner(organisationId = ORG_A, workerId = WORKER_1): QueueOwner {
  const o = { organisationId, workerId };
  owners.push(o);
  return o;
}

/** A clock the test moves by hand. */
function fakeClock(start = 1_800_000_000_000, origin = 1_799_999_000_000) {
  let now = start;
  let mono = 1_000;
  const clock: QueueClock & { advance(ms: number): void } = {
    now: () => now,
    monotonic: () => mono,
    timeOrigin: () => origin,
    advance(ms) {
      now += ms;
      mono += ms;
    },
  };
  return clock;
}

function recordingSender(results: (SendResult | Error)[]) {
  const sent: AnyQueueItem[] = [];
  const owners: QueueOwner[] = [];
  const sender: QueueSender = {
    async send(item, _timing, owner) {
      sent.push(item);
      owners.push(owner);
      const next = results.length > 1 ? results.shift()! : results[0]!;
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { sender, sent, owners };
}

const ok: SendResult = { ok: true };
const opts = (clock: QueueClock) => ({ clock, random: () => 0, locks: null });

afterEach(async () => {
  for (const o of owners.splice(0)) await deleteQueueDb(o);
});

describe("queue database", () => {
  it("names one database per organisation and worker, and only for UUIDs", () => {
    expect(queueDbName(owner())).toBe(`metalira-queue:${ORG_A}:${WORKER_1}`);
    expect(() => queueDbName({ organisationId: "../x", workerId: WORKER_1 })).toThrow();
    expect(ownerFromDbName(`metalira-queue:${ORG_A}:${WORKER_1}`)).toEqual({
      organisationId: ORG_A,
      workerId: WORKER_1,
    });
    expect(ownerFromDbName("metalira-queue:x:y")).toBeNull();
    expect(ownerFromDbName("other-db")).toBeNull();
  });
});

describe("enqueue", () => {
  it("saves a queued item with a device id, device time and monotonic reference", async () => {
    const clock = fakeClock();
    const db = queueDb(owner());
    const item = await enqueue(db, { kind: "test_ping", payload: { note: "a" } }, clock);
    expect(item.client_event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(item).toMatchObject({
      organisation_id: ORG_A,
      worker_id: WORKER_1,
      status: "queued",
      attempts: 0,
      last_error: null,
      device_time: clock.now(),
      device_elapsed: {
        monotonic_ms: 1_000,
        time_origin_ms: clock.timeOrigin(),
        wall_ms: clock.now(),
      },
    });
    expect(await db.punchQueue.get(item.client_event_id)).toMatchObject({ payload: { note: "a" } });
    expect(await countPending(db)).toBe(1);
  });

  it("keeps the first row when the same client_event_id is queued twice", async () => {
    const clock = fakeClock();
    const db = queueDb(owner());
    const id = "1d7c0f9e-5a4b-4c3d-8e2f-0a1b2c3d4e5f";
    await enqueue(db, { kind: "test_ping", payload: { note: "first" }, clientEventId: id }, clock);
    clock.advance(1_000);
    const again = await enqueue(
      db,
      { kind: "test_ping", payload: { note: "second" }, clientEventId: id },
      clock,
    );
    expect(again.payload).toEqual({ note: "first" });
    expect(await db.punchQueue.count()).toBe(1);
  });

  it("stores an optional photo blob", async () => {
    const db = queueDb(owner());
    const photo = new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" });
    const item = await enqueue(db, { kind: "test_ping", payload: { note: "p" }, photo });
    const row = await db.punchQueue.get(item.client_event_id);
    expect(row?.photo).toBeDefined();
    expect(row?.photo?.size).toBe(3);
  });
});

describe("backoff", () => {
  it("doubles from 5 s and caps at 15 minutes, with jitter only downwards", () => {
    expect(backoffDelay(1, 0)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelay(2, 0)).toBe(BACKOFF_BASE_MS * 2);
    expect(backoffDelay(5, 0)).toBe(BACKOFF_BASE_MS * 16);
    expect(backoffDelay(50, 0)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(1, 0.999)).toBeGreaterThan(BACKOFF_BASE_MS * 0.8);
    expect(backoffDelay(1, 0.999)).toBeLessThan(BACKOFF_BASE_MS);
    expect(backoffDelay(0, 0)).toBe(BACKOFF_BASE_MS);
  });
});

describe("send timing", () => {
  it("gives the monotonic elapsed time in the same page session, and null after a reload", async () => {
    const clock = fakeClock();
    const db = queueDb(owner());
    const item = await enqueue(db, { kind: "test_ping", payload: { note: "t" } }, clock);
    clock.advance(42_000);
    expect(sendTiming(item, clock)).toEqual({
      sent_device_time: clock.now(),
      elapsed_since_event_ms: 42_000,
    });
    const reloaded: QueueClock = { ...clock, timeOrigin: () => clock.timeOrigin() + 60_000 };
    expect(sendTiming(item, reloaded).elapsed_since_event_ms).toBeNull();
  });
});

describe("drainQueue", () => {
  it("sends due items oldest first with their owner, and deletes them once acknowledged", async () => {
    const clock = fakeClock();
    const db = queueDb(owner());
    const photo = new Blob([new Uint8Array([9])]);
    const a = await enqueue(db, { kind: "test_ping", payload: { note: "a" }, photo }, clock);
    clock.advance(10);
    const b = await enqueue(db, { kind: "test_ping", payload: { note: "b" } }, clock);
    const { sender, sent, owners: seen } = recordingSender([ok]);

    const report = await drainQueue(db, sender, opts(clock));

    expect(report).toMatchObject({ sent: 2, retried: 0, refused: 0, stopped: null });
    expect(sent.map((i) => i.client_event_id)).toEqual([a.client_event_id, b.client_event_id]);
    expect(seen).toEqual([db.owner, db.owner]);
    // Nothing about a sent event (payload, clocks, photo) stays on the phone.
    expect(await db.punchQueue.get(a.client_event_id)).toBeUndefined();
    expect(await db.punchQueue.count()).toBe(0);
    expect(await countPending(db)).toBe(0);
    expect(await countUnsent(db)).toBe(0);
  });

  it("on a transient failure keeps the item, backs off and stops the run", async () => {
    const clock = fakeClock();
    const db = queueDb(owner());
    const a = await enqueue(db, { kind: "test_ping", payload: { note: "a" } }, clock);
    clock.advance(1);
    await enqueue(db, { kind: "test_ping", payload: { note: "b" } }, clock);
    const { sender, sent } = recordingSender([new TypeError("Failed to fetch")]);

    const report = await drainQueue(db, sender, opts(clock));

    expect(report).toMatchObject({ sent: 0, retried: 1 });
    expect(sent).toHaveLength(1);
    expect(await db.punchQueue.get(a.client_event_id)).toMatchObject({
      status: "queued",
      attempts: 1,
      // A fixed code, never the exception's message.
      last_error: "network",
      next_attempt_at: clock.now() + BACKOFF_BASE_MS,
    });

    // Not due yet: an unforced run skips it.
    const early = recordingSender([ok]);
    await drainQueue(db, early.sender, opts(clock));
    // The second item was never tried, so it is due and goes; the first waits.
    expect(early.sent.map((i) => i.payload)).toEqual([{ note: "b" }]);

    // After the backoff it is sent.
    clock.advance(BACKOFF_BASE_MS);
    const later = recordingSender([ok]);
    expect(await drainQueue(db, later.sender, opts(clock))).toMatchObject({ sent: 1 });
    expect(await countPending(db)).toBe(0);
  });

  it("a forced run (network back) ignores the backoff", async () => {
    const clock = fakeClock();
    const db = queueDb(owner());
    await enqueue(db, { kind: "test_ping", payload: { note: "a" } }, clock);
    await drainQueue(
      db,
      recordingSender([{ ok: false, retryable: true, error: "server_error" }]).sender,
      opts(clock),
    );
    const report = await drainQueue(db, recordingSender([ok]).sender, {
      ...opts(clock),
      force: true,
    });
    expect(report.sent).toBe(1);
  });

  it("a non-retryable answer marks the item failed_permanent, keeps it, and moves on", async () => {
    const clock = fakeClock();
    const db = queueDb(owner());
    const a = await enqueue(db, { kind: "test_ping", payload: { note: "bad" } }, clock);
    clock.advance(1);
    await enqueue(db, { kind: "test_ping", payload: { note: "good" } }, clock);
    const { sender } = recordingSender([{ ok: false, retryable: false, error: "invalid" }, ok]);

    const report = await drainQueue(db, sender, opts(clock));

    expect(report).toMatchObject({ sent: 1, refused: 1 });
    expect(await db.punchQueue.get(a.client_event_id)).toMatchObject({
      status: "failed_permanent",
      attempts: 1,
      last_error: "invalid",
      failed_at: clock.now(),
    });
    expect(await countPending(db)).toBe(0);
    expect(await countUnsent(db)).toBe(1);
    // Never retried automatically.
    const retry = recordingSender([ok]);
    await drainQueue(db, retry.sender, { ...opts(clock), force: true });
    expect(retry.sent).toHaveLength(0);
  });

  it("loses nothing when the app dies mid-send: the next run resends the same event", async () => {
    const clock = fakeClock();
    const o = owner();
    const db = queueDb(o);
    const a = await enqueue(db, { kind: "test_ping", payload: { note: "a" } }, clock);

    // The sender never answers (the tab is killed while the request is in flight).
    const hung: QueueSender = { send: () => new Promise<SendResult>(() => {}) };
    void drainQueue(db, hung, opts(clock));
    await vi.waitFor(async () => {
      expect((await db.punchQueue.get(a.client_event_id))?.status).toBe("sending");
    });

    // The app starts again: a new connection to the same database.
    const restarted = new QueueDb(o);
    const { sender, sent } = recordingSender([ok]);
    const report = await drainQueue(restarted, sender, opts(clock));
    restarted.close();

    expect(report).toMatchObject({ recovered: 1, sent: 1 });
    // Same client_event_id: the server dedupes if the first request did arrive.
    expect(sent[0]?.client_event_id).toBe(a.client_event_id);
    expect(await db.punchQueue.get(a.client_event_id)).toBeUndefined();
  });

  it("does not run twice at once on the same database", async () => {
    const clock = fakeClock();
    const db = queueDb(owner());
    await enqueue(db, { kind: "test_ping", payload: { note: "a" } }, clock);
    let release: (r: SendResult) => void = () => {};
    const slow: QueueSender = { send: () => new Promise<SendResult>((r) => (release = r)) };
    const first = drainQueue(db, slow, opts(clock));
    expect(await drainQueue(db, slow, opts(clock))).toMatchObject({ stopped: "busy" });
    await vi.waitFor(() => expect(release).not.toBe(undefined));
    await vi.waitFor(async () =>
      expect(await db.punchQueue.where("status").equals("sending").count()).toBe(1),
    );
    release(ok);
    expect(await first).toMatchObject({ sent: 1 });
  });

  it("keeps a row untouched and stops when the server says the session is someone else's", async () => {
    const clock = fakeClock();
    const db = queueDb(owner());
    const a = await enqueue(db, { kind: "test_ping", payload: { note: "a" } }, clock);
    clock.advance(1);
    await enqueue(db, { kind: "test_ping", payload: { note: "b" } }, clock);
    const { sender, sent } = recordingSender([{ ok: false, wrongSession: true }]);

    const report = await drainQueue(db, sender, { ...opts(clock), force: true });

    expect(report).toMatchObject({ sent: 0, retried: 0, refused: 0, stopped: "wrong_session" });
    expect(sent).toHaveLength(1);
    expect(await db.punchQueue.get(a.client_event_id)).toMatchObject({
      status: "queued",
      attempts: 0,
      last_error: null,
      failed_at: null,
    });
    expect(await countPending(db)).toBe(2);
  });

  it("never hands the sender a row whose owner is not the queue's", async () => {
    const clock = fakeClock();
    const db = queueDb(owner());
    const foreign = await enqueue(db, { kind: "test_ping", payload: { note: "x" } }, clock);
    await db.punchQueue.update(foreign.client_event_id, { worker_id: WORKER_2 });
    const { sender, sent } = recordingSender([ok]);
    await drainQueue(db, sender, { ...opts(clock), force: true });
    expect(sent).toHaveLength(0);
  });

  it("stores only fixed error codes", () => {
    expect(toErrorCode("timeout")).toBe("timeout");
    expect(toErrorCode("Worker 0114 at Apapa has no shift")).toBe("unknown");
    expect(toErrorCode(undefined)).toBe("unknown");
  });

  it("deletes refused rows after 3 days and unsent rows after 14 days", async () => {
    const clock = fakeClock();
    const db = queueDb(owner());
    const refused = await enqueue(db, { kind: "test_ping", payload: { note: "bad" } }, clock);
    await drainQueue(
      db,
      recordingSender([{ ok: false, retryable: false, error: "invalid" }]).sender,
      opts(clock),
    );
    clock.advance(FAILED_RETENTION_MS + 1);
    const recent = await enqueue(db, { kind: "test_ping", payload: { note: "new" } }, clock);
    expect(await pruneQueue(db, clock.now())).toBe(1);
    expect(await db.punchQueue.get(refused.client_event_id)).toBeUndefined();
    expect(await db.punchQueue.get(recent.client_event_id)).toBeDefined();

    clock.advance(UNSENT_MAX_AGE_MS + 1);
    await drainQueue(db, recordingSender([new Error("down")]).sender, opts(clock));
    expect(await db.punchQueue.count()).toBe(0);
  });
});

describe("housekeeping on sign-in", () => {
  it("deletes other workers' queues with nothing unsent and expires old rows everywhere", async () => {
    const clock = fakeClock();
    const me = owner(ORG_A, WORKER_1);
    const emptyOther = owner(ORG_A, WORKER_2);
    const busyOther = owner(ORG_B, WORKER_1);
    await enqueue(queueDb(me), { kind: "test_ping", payload: { note: "mine" } }, clock);
    const e = queueDb(emptyOther);
    await enqueue(e, { kind: "test_ping", payload: { note: "sent" } }, clock);
    await drainQueue(e, recordingSender([ok]).sender, opts(clock));
    await enqueue(queueDb(busyOther), { kind: "test_ping", payload: { note: "waiting" } }, clock);

    const report = await housekeepQueues(me, clock.now());

    const names = await Dexie.getDatabaseNames();
    expect(report.deletedQueues).toBe(1);
    expect(names).not.toContain(queueDbName(emptyOther));
    expect(names).toContain(queueDbName(busyOther));
    expect(names).toContain(queueDbName(me));

    // Two weeks on, the other worker's unsent row has expired and its queue goes too.
    const later = await housekeepQueues(me, clock.now() + UNSENT_MAX_AGE_MS + 1);
    expect(later.deletedQueues).toBe(1);
    expect(await Dexie.getDatabaseNames()).not.toContain(queueDbName(busyOther));
  });
});

describe("per-worker isolation", () => {
  it("keeps each worker's and each organisation's queue apart", async () => {
    const clock = fakeClock();
    const a1 = queueDb(owner(ORG_A, WORKER_1));
    const a2 = queueDb(owner(ORG_A, WORKER_2));
    const b1 = queueDb(owner(ORG_B, WORKER_1));
    await enqueue(a1, { kind: "test_ping", payload: { note: "a1" } }, clock);
    await enqueue(a1, { kind: "test_ping", payload: { note: "a1 again" } }, clock);
    await enqueue(a2, { kind: "test_ping", payload: { note: "a2" } }, clock);

    expect(await countPending(a1)).toBe(2);
    expect(await countPending(a2)).toBe(1);
    expect(await countPending(b1)).toBe(0);

    // Draining one worker's queue never sends another's.
    const { sender, sent } = recordingSender([ok]);
    await drainQueue(a2, sender, opts(clock));
    expect(sent.map((i) => i.payload)).toEqual([{ note: "a2" }]);
    expect(await countPending(a1)).toBe(2);

    // Deleting one (sign-out) leaves the others.
    await deleteQueueDb({ organisationId: ORG_A, workerId: WORKER_1 });
    expect(await countPending(queueDb({ organisationId: ORG_A, workerId: WORKER_1 }))).toBe(0);
    expect(await countUnsent(a2)).toBe(0);
    expect(await a2.punchQueue.count()).toBe(0);
  });
});

describe("SyncEngine", () => {
  function fakeEnv(online = true) {
    const handlers = {
      online: [] as (() => void)[],
      visible: [] as (() => void)[],
      tick: [] as (() => void)[],
    };
    const env: SyncEnvironment & { online: boolean } = {
      online,
      isOnline: () => env.online,
      onOnline: (l) => (handlers.online.push(l), () => {}),
      onVisible: (l) => (handlers.visible.push(l), () => {}),
      every: (_ms, l) => (handlers.tick.push(l), () => {}),
    };
    return { env, handlers };
  }

  it("drains on start, does nothing offline, and drains when the network returns", async () => {
    const clock = fakeClock();
    const db = queueDb(owner());
    await enqueue(db, { kind: "test_ping", payload: { note: "a" } }, clock);
    const { env, handlers } = fakeEnv(false);
    const { sender, sent } = recordingSender([ok]);
    const engine = new SyncEngine({ db, getSender: () => sender, env, drain: opts(clock) });

    engine.start();
    expect(await engine.sync("start")).toMatchObject({ stopped: "offline" });
    expect(sent).toHaveLength(0);

    env.online = true;
    handlers.online[0]!();
    await vi.waitFor(async () => expect(await countPending(db)).toBe(0));
    expect(sent).toHaveLength(1);
    engine.stop();
  });

  it("sends nothing while the browser session is not the queue's owner", async () => {
    const clock = fakeClock();
    const db = queueDb(owner());
    await enqueue(db, { kind: "test_ping", payload: { note: "a" } }, clock);
    const { env } = fakeEnv();
    const { sender, sent } = recordingSender([ok]);
    let mine = false;
    const engine = new SyncEngine({
      db,
      getSender: () => sender,
      isOwnerSignedIn: async () => mine,
      env,
      drain: opts(clock),
    });
    expect(await engine.sync("manual")).toMatchObject({ stopped: "wrong_session" });
    expect(sent).toHaveLength(0);
    mine = true;
    expect(await engine.sync("manual")).toMatchObject({ sent: 1 });
  });

  it("uses the sender registered while it checked the session, not the one before", async () => {
    const clock = fakeClock();
    const db = queueDb(owner());
    await enqueue(db, { kind: "test_ping", payload: { note: "a" } }, clock);
    const { env } = fakeEnv();
    const before = recordingSender([ok]);
    const after = recordingSender([ok]);
    let current = before.sender;
    let signIn!: (value: boolean) => void;
    const engine = new SyncEngine({
      db,
      getSender: () => current,
      isOwnerSignedIn: () => new Promise<boolean>((resolve) => (signIn = resolve)),
      env,
      drain: opts(clock),
    });
    const run = engine.sync("manual");
    current = after.sender;
    signIn(true);
    expect(await run).toMatchObject({ sent: 1 });
    expect(before.sent).toHaveLength(0);
    expect(after.sent).toHaveLength(1);
  });

  it("does nothing after it is stopped", async () => {
    const db = queueDb(owner());
    await enqueue(db, { kind: "test_ping", payload: { note: "a" } });
    const { env } = fakeEnv();
    const { sender, sent } = recordingSender([ok]);
    const engine = new SyncEngine({ db, getSender: () => sender, env });
    engine.stop();
    expect(await engine.sync("manual")).toMatchObject({ stopped: "stopped" });
    expect(sent).toHaveLength(0);
  });

  it("leaves items queued while no sender is registered (3.5 provides it)", async () => {
    const db = queueDb(owner());
    await enqueue(db, { kind: "test_ping", payload: { note: "a" } });
    const { env } = fakeEnv();
    const engine = new SyncEngine({ db, getSender: () => null, env });
    expect(await engine.sync("manual")).toMatchObject({ stopped: "no_sender" });
    expect(await countPending(db)).toBe(1);
  });

  it("runs again after the current run when triggered meanwhile", async () => {
    const clock = fakeClock();
    const db = queueDb(owner());
    const { env, handlers } = fakeEnv();
    const { sender, sent } = recordingSender([ok]);
    const engine = new SyncEngine({ db, getSender: () => sender, env, drain: opts(clock) });
    engine.start();
    await enqueue(db, { kind: "test_ping", payload: { note: "late" } }, clock);
    handlers.visible[0]!();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    engine.stop();
  });
});

describe("storage warning", () => {
  it("warns when free space is low or the quota is nearly used, never on unknown numbers", () => {
    expect(isStorageLow(null)).toBe(false);
    expect(isStorageLow({})).toBe(false);
    expect(isStorageLow({ usage: 0, quota: 0 })).toBe(false);
    expect(isStorageLow({ usage: 10, quota: 2_000_000_000 })).toBe(false);
    expect(isStorageLow({ usage: 0, quota: 10 * 1024 * 1024 })).toBe(true);
    expect(isStorageLow({ usage: 950, quota: 1000 * 1024 * 1024 })).toBe(false);
    expect(isStorageLow({ usage: 950 * 1024 * 1024, quota: 1000 * 1024 * 1024 })).toBe(true);
  });
});
