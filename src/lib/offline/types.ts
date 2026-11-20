/**
 * The worker app's offline queue (slice 3.4): events a worker makes on the phone (clock-in,
 * clock-out, patrol scans) are saved in IndexedDB first and sent when the network allows. The
 * queue is generic: slice 3.5 adds the punch kinds and the real sender.
 *
 * Isomorphic: runs in the page and could run in the service worker. No React, no server code.
 */

/**
 * Payload per event kind. Later slices add their kinds by declaration merging, so `enqueue`
 * stays fully typed without this file knowing about punches:
 *
 * ```ts
 * declare module "@/lib/offline/types" {
 *   interface QueuePayloads {
 *     clock_in: { site_id: string; latitude: number; longitude: number; accuracy_m: number };
 *   }
 * }
 * ```
 *
 * `test_ping` is the only kind 3.4 ships: the end-to-end test queues one and drains it with
 * the test sender. No production code queues it.
 */
export interface QueuePayloads {
  test_ping: { note: string };
}

export type QueueKind = keyof QueuePayloads & string;

/**
 * - `queued`: waiting to be sent (first try, or a retry after `next_attempt_at`).
 * - `sending`: handed to the sender; back to `queued` if the app dies before the answer.
 * - `failed_permanent`: the server refused it for good (validation). Kept 3 days so the worker
 *   can tell a supervisor, then deleted; never retried automatically.
 *
 * There is no `sent` row: once the server acknowledges an item, the row (payload, clocks,
 * photo) is deleted from the phone (security review M3).
 */
export type QueueStatus = "queued" | "sending" | "failed_permanent";

/** Statuses that still need the network (the "saved on phone" count). */
export const PENDING_STATUSES: readonly QueueStatus[] = ["queued", "sending"];
/** Statuses that are not on the server (the sign-out warning count). */
export const UNSENT_STATUSES: readonly QueueStatus[] = ["queued", "sending", "failed_permanent"];

/**
 * How long rows may stay on the phone (security review M3). Also in the PR as-built notes.
 * - Sent: deleted on the server's acknowledgement.
 * - Refused (`failed_permanent`): 3 days after the refusal.
 * - Unsent: 14 days after the event; a punch that old is no longer useful and only holds
 *   personal data (location, photo).
 * - Another worker's queue on a shared phone: deleted at the next sign-in on this phone if it
 *   holds nothing unsent; otherwise its rows follow the same limits.
 */
export const FAILED_RETENTION_MS = 3 * 24 * 60 * 60_000;
export const UNSENT_MAX_AGE_MS = 14 * 24 * 60 * 60_000;

/**
 * Fixed error codes, the only values `last_error` may hold (security review L3): never a
 * server message, an exception text or anything from the payload.
 */
export const QUEUE_ERROR_CODES = [
  "network",
  "timeout",
  "server_error",
  "rate_limited",
  "rejected",
  "invalid",
  "wrong_session",
  "unknown",
] as const;
export type QueueErrorCode = (typeof QUEUE_ERROR_CODES)[number];

export function toErrorCode(value: unknown): QueueErrorCode {
  return (QUEUE_ERROR_CODES as readonly unknown[]).includes(value)
    ? (value as QueueErrorCode)
    : "unknown";
}

/**
 * The device's clocks at the moment of the event, so the server can correct a wrong phone
 * clock (slice 3.5). `performance.now()` is monotonic (a user changing the phone's time does
 * not move it) but restarts with each page load, so it is only comparable within the same
 * `time_origin_ms`.
 */
export interface DeviceElapsed {
  /** `performance.now()` at the event (ms since `time_origin_ms`). */
  monotonic_ms: number;
  /** `performance.timeOrigin` of the page that captured the event (ms epoch, device clock). */
  time_origin_ms: number;
  /** `Date.now()` at the event (ms epoch, device clock). Same instant as `monotonic_ms`. */
  wall_ms: number;
}

/** One row of the `punchQueue` table. */
export interface QueueItem<K extends QueueKind = QueueKind> {
  /** UUID v4 made on the phone. The server's idempotency key: a resend is never a second punch. */
  client_event_id: string;
  /**
   * Whose event it is (security review M2). The server must compare these with the session
   * and refuse with `wrong_session` on a mismatch; a duplicate client_event_id counts as
   * already received only for the same worker.
   */
  organisation_id: string;
  worker_id: string;
  kind: K;
  payload: QueuePayloads[K];
  /** When the event happened, by the phone's clock (ms epoch). */
  device_time: number;
  device_elapsed: DeviceElapsed;
  /** Optional photo (selfie, crew photo). */
  photo?: Blob;
  /** Send attempts that ended in a failure. */
  attempts: number;
  last_error: QueueErrorCode | null;
  status: QueueStatus;
  /** When the item was saved (ms epoch, phone clock). The send order. */
  created_at: number;
  /** Earliest time the next automatic try may start (ms epoch). Backoff after a failure. */
  next_attempt_at: number;
  /** When the server refused it for good (`failed_permanent`), for the 3-day clean-up. */
  failed_at: number | null;
}

/** A row of any kind, narrowed by `kind`. */
export type AnyQueueItem = { [K in QueueKind]: QueueItem<K> }[QueueKind];

/**
 * What the sender adds at send time so the server can work out the real event time:
 *
 * - `elapsed_since_event_ms` known (same page session as the event): event time =
 *   server receive time - elapsed. Immune to a wrong phone clock.
 * - otherwise: event time = device_time + (server receive time - sent_device_time), which
 *   corrects a phone clock that is off by a constant amount.
 */
export interface SendTiming {
  /** `Date.now()` just before the send. */
  sent_device_time: number;
  /** Monotonic ms between the event and the send, or null after a reload or restart. */
  elapsed_since_event_ms: number | null;
}

/**
 * The sender's answer. Throwing counts as a transient `network` failure. Errors are fixed
 * codes only (anything else is stored as `unknown`).
 *
 * - `ok`: the server has it. A duplicate `client_event_id` from the same worker is `ok`.
 * - `retryable`: try again later with backoff.
 * - not `retryable`: refused for good (`failed_permanent`).
 * - `wrong_session`: the signed-in session is not the item's owner. The item stays queued
 *   untouched (no attempt counted, never sent or refused) and the drain stops.
 */
export type SendResult =
  | { ok: true }
  | { ok: false; retryable: true; error: QueueErrorCode }
  | { ok: false; retryable: false; error: QueueErrorCode }
  | { ok: false; wrongSession: true };

/** Sends one item to the server. Slice 3.5 provides the real one. */
export interface QueueSender {
  /** `owner` is the queue's owner; it always equals the item's organisation_id and worker_id. */
  send(item: AnyQueueItem, timing: SendTiming, owner: QueueOwner): Promise<SendResult>;
}

/** Whose queue it is: one queue per signed-in worker in one organisation. */
export interface QueueOwner {
  organisationId: string;
  workerId: string;
}
