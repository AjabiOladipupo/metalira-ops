import { backoffDelay } from "./backoff";
import type { QueueDb } from "./db";
import { sendTiming, systemClock, type QueueClock } from "./queue";
import type { AnyQueueItem, QueueSender, SendResult } from "./types";

/** Sent rows are kept a week (for "sent" history and dedupe), then removed. */
export const SENT_RETENTION_MS = 7 * 24 * 60 * 60_000;
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
  /** Why the run stopped early, if it did. */
  stopped: "busy" | "no_sender" | "offline" | null;
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
  stopped,
});

/** Drains already running in this page, by database, so two triggers never overlap. */
const running = new WeakSet<QueueDb>();

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 300) || "Send failed";
}

async function attempt(
  sender: QueueSender,
  item: AnyQueueItem,
  clock: QueueClock,
): Promise<SendResult> {
  try {
    return await sender.send(item, sendTiming(item, clock));
  } catch (error) {
    // A thrown error is a network failure or a timeout: worth trying again.
    return { ok: false, retryable: true, error: errorText(error) };
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
  const now = clock.now();

  // Rows still `sending` here were handed to a sender by a run that never finished (the app
  // was closed or crashed mid-send). The server may or may not have them; sending again is
  // safe because it dedupes on client_event_id.
  report.recovered = await db.punchQueue
    .where("status")
    .equals("sending")
    .modify({ status: "queued" });

  await db.punchQueue
    .where("[status+created_at]")
    .between(["sent", -Infinity], ["sent", now - SENT_RETENTION_MS])
    .delete();

  // Oldest first, so the server sees a clock-in before its clock-out.
  const queued = await db.punchQueue
    .where("[status+created_at]")
    .between(["queued", -Infinity], ["queued", Infinity])
    .toArray();

  for (const item of queued) {
    if (!force && item.next_attempt_at > clock.now()) continue;

    // Mark before sending: if the app dies now, the next run recovers the row.
    await db.punchQueue.update(item.client_event_id, { status: "sending" });
    const result = await attempt(sender, item, clock);
    const at = clock.now();

    if (result.ok) {
      // The photo has reached the server; free the phone's storage.
      await db.punchQueue.update(item.client_event_id, {
        status: "sent",
        sent_at: at,
        last_error: null,
        photo: undefined,
      });
      report.sent += 1;
      continue;
    }

    const attempts = item.attempts + 1;
    if (!result.retryable) {
      await db.punchQueue.update(item.client_event_id, {
        status: "failed_permanent",
        attempts,
        last_error: result.error,
      });
      report.refused += 1;
      continue;
    }

    await db.punchQueue.update(item.client_event_id, {
      status: "queued",
      attempts,
      last_error: result.error,
      next_attempt_at: at + backoffDelay(attempts, random()),
    });
    report.retried += 1;
    // The network is probably down: stop rather than fail every row in turn.
    break;
  }
  return report;
}

/**
 * Sends every due item once, oldest first. Never deletes an unsent row: each outcome is
 * written back before the next item, and a row left mid-send is recovered on the next run.
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

  constructor(private readonly options: SyncEngineOptions) {
    this.env = options.env ?? browserEnvironment;
  }

  start(): void {
    if (this.stops.length > 0) return;
    this.stops.push(
      this.env.onOnline(() => void this.sync("online")),
      this.env.onVisible(() => void this.sync("visible")),
      this.env.every(this.options.intervalMs ?? SYNC_INTERVAL_MS, () => void this.sync("interval")),
    );
    void this.sync("start");
  }

  stop(): void {
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
    const sender = this.options.getSender();
    if (!sender) return empty("no_sender");
    if (!this.env.isOnline()) return empty("offline");
    return drainQueue(this.options.db, sender, {
      ...this.options.drain,
      force: FORCED.has(reason),
    });
  }
}
