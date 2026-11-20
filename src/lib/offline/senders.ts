import type { QueueSender } from "./types";

/**
 * The sender the sync engine uses. Slice 3.4 ships none for real traffic: until slice 3.5
 * registers the punch sender, queued items simply wait (they are never marked sent without
 * reaching the server). 3.5 calls `setQueueSender(punchSender)` from its client module.
 *
 * Contract for 3.5's sender and its server function (security review M2, L3):
 * - Send `item.organisation_id` and `item.worker_id`; the server compares them with the
 *   session's organisation and worker and answers `{ ok: false, wrongSession: true }` on a
 *   mismatch (the item stays queued for its owner).
 * - A duplicate `client_event_id` is `ok` only when the stored punch is the same worker's;
 *   for anyone else it is a mismatch, never an acknowledgement.
 * - Errors are fixed codes (QueueErrorCode), never server messages or payload values.
 */
let current: QueueSender | null = null;
const listeners = new Set<() => void>();

export function setQueueSender(sender: QueueSender | null): void {
  current = sender;
  for (const listener of listeners) listener();
}

export function getQueueSender(): QueueSender | null {
  return current;
}

/** Called when a sender is registered, so the engine can drain straight away. */
export function onQueueSenderChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
