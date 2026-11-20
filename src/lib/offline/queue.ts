import type { QueueDb } from "./db";
import {
  PENDING_STATUSES,
  UNSENT_STATUSES,
  type AnyQueueItem,
  type DeviceElapsed,
  type QueueItem,
  type QueueKind,
  type QueuePayloads,
  type SendTiming,
} from "./types";

/** The clocks the queue reads. Injected in tests. */
export interface QueueClock {
  /** ms epoch (`Date.now`). */
  now(): number;
  /** Monotonic ms (`performance.now`). */
  monotonic(): number;
  /** `performance.timeOrigin`. */
  timeOrigin(): number;
}

export const systemClock: QueueClock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  timeOrigin: () => performance.timeOrigin,
};

/** A UUID v4 made on the phone. */
export function newClientEventId(): string {
  return crypto.randomUUID();
}

export interface EnqueueInput<K extends QueueKind> {
  kind: K;
  payload: QueuePayloads[K];
  photo?: Blob;
  /** Only for retries of an already built event; normally made here. */
  clientEventId?: string;
}

/** The device clocks right now, for an event happening now. */
export function captureDeviceElapsed(clock: QueueClock = systemClock): DeviceElapsed {
  return {
    monotonic_ms: clock.monotonic(),
    time_origin_ms: clock.timeOrigin(),
    wall_ms: clock.now(),
  };
}

/**
 * Saves an event on the phone. The write is committed before this resolves, so the worker can
 * be told "saved" even with no network. Re-adding the same `client_event_id` keeps the first
 * row (the event happened once).
 */
export async function enqueue<K extends QueueKind>(
  db: QueueDb,
  input: EnqueueInput<K>,
  clock: QueueClock = systemClock,
): Promise<QueueItem<K>> {
  const elapsed = captureDeviceElapsed(clock);
  const item: QueueItem<K> = {
    client_event_id: input.clientEventId ?? newClientEventId(),
    kind: input.kind,
    payload: input.payload,
    device_time: elapsed.wall_ms,
    device_elapsed: elapsed,
    ...(input.photo ? { photo: input.photo } : {}),
    attempts: 0,
    last_error: null,
    status: "queued",
    created_at: elapsed.wall_ms,
    next_attempt_at: elapsed.wall_ms,
    sent_at: null,
  };
  return db.transaction("rw", db.punchQueue, async () => {
    const existing = await db.punchQueue.get(item.client_event_id);
    if (existing) return existing as QueueItem<K>;
    await db.punchQueue.add(item as AnyQueueItem);
    return item;
  });
}

/** Items waiting for the network (the banner's "saved on phone" count). */
export function countPending(db: QueueDb): Promise<number> {
  return db.punchQueue.where("status").anyOf(PENDING_STATUSES).count();
}

/** Items the server does not have, including refused ones (the sign-out warning). */
export function countUnsent(db: QueueDb): Promise<number> {
  return db.punchQueue.where("status").anyOf(UNSENT_STATUSES).count();
}

/** The timing the sender passes on, for the server's corrected event time. */
export function sendTiming(item: AnyQueueItem, clock: QueueClock = systemClock): SendTiming {
  const sameSession = item.device_elapsed.time_origin_ms === clock.timeOrigin();
  const elapsed = clock.monotonic() - item.device_elapsed.monotonic_ms;
  return {
    sent_device_time: clock.now(),
    elapsed_since_event_ms: sameSession && elapsed >= 0 ? Math.round(elapsed) : null,
  };
}
