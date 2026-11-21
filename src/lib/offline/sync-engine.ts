import { backoffDelay } from "./backoff";
import type { QueueDb } from "./db";
import { sendTiming, systemClock, type QueueClock } from "./queue";
import {
  FAILED_RETENTION_MS,
  toErrorCode,
  UNSENT_MAX_AGE_MS,
  type AnyQueueItem,
  type QueueSender,
  type SendResult,
} from "./types";

/** While the app is open, the queue is checked this often (backoff still applies). */
export const SYNC_INTERVAL_MS = 30_000;

/** Why a sync ran. Forced reasons ignore backoff: the network or the app just came back. */
export type SyncReason = "start" | "online" | "visible" | "interval" | "background-sync" | "manual";
const FORCED: ReadonlySet<SyncReason> = new Set(["start", "online", "background-sync", "manual"]);

export interface DrainReport {
  sent: number;
  /** Transient failures (will retry with backoff). */
  retried: number;
  /** Refused for good by the server. */
  refused: number;
  /** Rows left in `sending` by an earlier run that died mid-send, put back in the queue. */
  recovered: number;
  /** Rows deleted by the retention limits (types.ts). */
  expired: number;
  /** Why the run stopped early, if it did. */
  stopped: "busy" | "no_sender" | "offline" | "wrong_session" | "stopped" | null;
}

export interface DrainOptions {
  clock?: QueueClock;
  /** Jitter source for backoff, in [0, 1). */
  random?: () => number;
  /** Ignore `next_attempt_at` (the network just came back). */
  force?: boolean;
  /**
   * Cross-tab lock (Web Locks). Two tabs draining at once would only send duplicates, which
   * the server ignores, but the lock avoids the wasted data. `null` turns it off (tests).
   */
  locks?: LockManager | null;
}

const empty = (stopped: DrainReport["stopped"] = null): DrainReport => ({
  sent: 0,
  retried: 0,
  refused: 0,
  recovered: 0,
  expired: 0,
  stopped,
});

/** Drains already running in this page, by database, so two triggers never overlap. */
const running = new WeakSet<QueueDb>();

/**
 * Applies the retention limits (security review M3): refused rows go 3 days after the
 * refusal, unsent rows 14 days after the event. Returns how many rows were deleted.
 */
export async function pruneQueue(db: QueueDb, now: number): Promise<number> {
  const refused = await db.punchQueue
    .where("failed_at")
    .below(now - FAILED_RETENTION_MS)
    .delete();
  const stale = await db.punchQueue
    .where("created_at")
    .below(now - UNSENT_MAX_AGE_MS)
    .delete();
  return refused + stale;
}

async function attempt(
  db: QueueDb,
  sender: QueueSender,
  item: AnyQueueItem,
  clock: QueueClock,
): Promise<SendResult> {
  try {
    return await sender.send(item, sendTiming(item, clock), db.owner);
  } catch {
    // A thrown error is a network failure or a timeout: worth trying again. Its message is
    // never stored (it could echo a server response).
    return { ok: false, retryable: true, error: "network" };
  }
}

async function drainLocked(
  db: QueueDb,
  sender: QueueSender,
  clock: QueueClock,
  random: () => number,
  force: boolean,
): Promise<DrainReport> {
  const report = empty();

  // Rows still `sending` here were handed to a sender by a run that never finished (the app
  // was closed or crashed mid-send). The server may or may not have them; sending again is
  // safe because it dedupes on client_event_id.
  report.recovered = await db.punchQueue
    .where("status")
    .equals("sending")
    .modify({ status: "queued" });
  report.expired = await pruneQueue(db, clock.now());

  // Oldest first, so the server sees a clock-in before its clock-out.
  const queued = await db.punchQueue
    .where("[status+created_at]")
    .between(["queued", -Infinity], ["queued", Infinity])
    .toArray();

  for (const item of queued) {
    if (!force && item.next_attempt_at > clock.now()) continue;
    // Defence in depth: a row that is not this queue's owner's is never handed to the sender.
    if (item.organisation_id !== db.owner.organisationId || item.worker_id !== db.owner.workerId) {
      continue;
    }

    // Mark before sending: if the app dies now, the next run recovers the row.
    await db.punchQueue.update(item.client_event_id, { status: "sending" });
    const result = await attempt(db, sender, item, clock);
    const at = clock.now();

    if (result.ok) {
      // The server has it: nothing about the event (payload, clocks, photo) stays on the phone.
      await db.punchQueue.delete(item.client_event_id);
      report.sent += 1;
      continue;
    }

    if ("wrongSession" in result) {
      // The session is someone else's: leave the row as it was and stop.
      await db.punchQueue.update(item.client_event_id, { status: "queued" });
      report.stopped = "wrong_session";
      break;
    }

    const attempts = item.attempts + 1;
    const error = toErrorCode(result.error);
    if (!result.retryable) {
      await db.punchQueue.update(item.client_event_id, {
        status: "failed_permanent",
        attempts,
        last_error: error,
        failed_at: at,
        // A refused patrol scan keeps no checkpoint token on the phone (slice 3.8 review L2):
        // it is never sent again, and a printed code is a shared secret.
        ...(item.kind === "checkpoint_scan" ? { payload: { ...item.payload, token: "" } } : {}),
      });
      report.refused += 1;
      continue;
    }

    await db.punchQueue.update(item.client_event_id, {
      status: "queued",
      attempts,
      last_error: error,
      next_attempt_at: at + backoffDelay(attempts, random()),
    });
    report.retried += 1;
    // The network is probably down: stop rather than fail every row in turn.
    break;
  }
  return report;
}

/**
 * Sends every due item once, oldest first. Never loses an unsent row: each outcome is written
 * back before the next item, and a row left mid-send is recovered on the next run. Rows are
 * deleted only on the server's acknowledgement or by the retention limits.
 */
export async function drainQueue(
  db: QueueDb,
  sender: QueueSender,
  options: DrainOptions = {},
): Promise<DrainReport> {
  const clock = options.clock ?? systemClock;
  const random = options.random ?? Math.random;
  const force = options.force ?? false;
  const locks =
    options.locks === undefined
      ? typeof navigator !== "undefined" && "locks" in navigator
        ? navigator.locks
        : null
      : options.locks;

  if (running.has(db)) return empty("busy");
  running.add(db);
  try {
    if (!locks) return await drainLocked(db, sender, clock, random, force);
    const result = await locks.request(`${db.name}:drain`, { ifAvailable: true }, async (lock) =>
      lock ? drainLocked(db, sender, clock, random, force) : empty("busy"),
    );
    return result as DrainReport;
  } finally {
    running.delete(db);
  }
}

/** How the engine hears about the network, the screen and time. Injected in tests. */
export interface SyncEnvironment {
  isOnline(): boolean;
  onOnline(listener: () => void): () => void;
  onVisible(listener: () => void): () => void;
  every(ms: number, listener: () => void): () => void;
}

export const browserEnvironment: SyncEnvironment = {
  isOnline: () => (typeof navigator === "undefined" ? true : navigator.onLine !== false),
  onOnline(listener) {
    window.addEventListener("online", listener);
    return () => window.removeEventListener("online", listener);
  },
  onVisible(listener) {
    const handler = () => {
      if (document.visibilityState === "visible") listener();
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  },
  every(ms, listener) {
    const id = setInterval(listener, ms);
    return () => clearInterval(id);
  },
};

export interface SyncEngineOptions {
  db: QueueDb;
  /** Read at each run, so a sender registered later is picked up. */
  getSender: () => QueueSender | null;
  /**
   * True while the signed-in session still belongs to this queue's owner. Checked before each
   * drain; on false nothing is sent (another worker signed in from another tab, or signed out).
   */
  isOwnerSignedIn?: () => boolean | Promise<boolean>;
  env?: SyncEnvironment;
  intervalMs?: number;
  drain?: Omit<DrainOptions, "force">;
}

/**
 * Runs the drain on app start, when the network returns, when the app comes back to the
 * foreground, on a timer while open, and on request (Background Sync messages from the
 * service worker). One run at a time; a trigger during a run queues one more run.
 */
export class SyncEngine {
  private readonly env: SyncEnvironment;
  private stops: (() => void)[] = [];
  private current: Promise<DrainReport | null> | null = null;
  private again: SyncReason | null = null;
  private stopped = false;

  constructor(private readonly options: SyncEngineOptions) {
    this.env = options.env ?? browserEnvironment;
  }

  start(): void {
    if (this.stops.length > 0) return;
    this.stopped = false;
    this.stops.push(
      this.env.onOnline(() => void this.sync("online")),
      this.env.onVisible(() => void this.sync("visible")),
      this.env.every(this.options.intervalMs ?? SYNC_INTERVAL_MS, () => void this.sync("interval")),
    );
    void this.sync("start");
  }

  stop(): void {
    this.stopped = true;
    this.again = null;
    for (const stop of this.stops) stop();
    this.stops = [];
  }

  /** Runs a drain now, or once more after the one in progress. */
  sync(reason: SyncReason): Promise<DrainReport | null> {
    if (this.current) {
      if (!this.again || FORCED.has(reason)) this.again = reason;
      return this.current;
    }
    this.current = this.run(reason).finally(() => {
      this.current = null;
      const next = this.again;
      this.again = null;
      if (next) void this.sync(next);
    });
    return this.current;
  }

  private async run(reason: SyncReason): Promise<DrainReport> {
    if (this.stopped) return empty("stopped");
    if (!this.options.getSender()) return empty("no_sender");
    if (!this.env.isOnline()) return empty("offline");
    if (this.options.isOwnerSignedIn) {
      let signedIn = false;
      try {
        signedIn = await this.options.isOwnerSignedIn();
      } catch {
        signedIn = false;
      }
      if (!signedIn || this.stopped) return empty("wrong_session");
    }
    // Read again after the session check: a sender registered while it ran is the one to use,
    // not the one this run saw before waiting.
    const sender = this.options.getSender();
    if (!sender) return empty("no_sender");
    return drainQueue(this.options.db, sender, {
      ...this.options.drain,
      force: FORCED.has(reason),
    });
  }
}
