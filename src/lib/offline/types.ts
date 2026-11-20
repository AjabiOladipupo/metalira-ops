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
 * - `sent`: the server has it (or already had it: it dedupes on `client_event_id`).
 * - `failed_permanent`: the server refused it for good (validation). Kept, never dropped, so a
 *   supervisor can see it; never retried automatically.
 */
export type QueueStatus = "queued" | "sending" | "sent" | "failed_permanent";

/** Statuses that still need the network (the "saved on phone" count). */
export const PENDING_STATUSES: readonly QueueStatus[] = ["queued", "sending"];
/** Statuses that are not on the server (the sign-out warning count). */
export const UNSENT_STATUSES: readonly QueueStatus[] = ["queued", "sending", "failed_permanent"];

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
  kind: K;
  payload: QueuePayloads[K];
  /** When the event happened, by the phone's clock (ms epoch). */
  device_time: number;
  device_elapsed: DeviceElapsed;
  /** Optional photo (selfie, crew photo), dropped once the item is sent. */
  photo?: Blob;
  /** Send attempts that ended in a failure. */
  attempts: number;
  last_error: string | null;
  status: QueueStatus;
  /** When the item was saved (ms epoch, phone clock). The send order. */
  created_at: number;
  /** Earliest time the next automatic try may start (ms epoch). Backoff after a failure. */
  next_attempt_at: number;
  sent_at: number | null;
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
 * The sender's answer. Throwing counts as a transient failure (network down, timeout).
 * A duplicate `client_event_id` must come back as `ok` (the server already has it).
 */
export type SendResult =
  | { ok: true }
  | { ok: false; retryable: true; error: string }
  | { ok: false; retryable: false; error: string };

/** Sends one item to the server. Slice 3.5 provides the real one. */
export interface QueueSender {
  send(item: AnyQueueItem, timing: SendTiming): Promise<SendResult>;
}

/** Whose queue it is: one queue per signed-in worker in one organisation. */
export interface QueueOwner {
  organisationId: string;
  workerId: string;
}
