import type { QueueSender } from "./types";

/**
 * The sender the sync engine uses. Slice 3.4 ships none for real traffic: until slice 3.5
 * registers the punch sender, queued items simply wait (they are never marked sent without
 * reaching the server). 3.5 calls `setQueueSender(punchSender)` from its client module.
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

/**
 * The end-to-end test sender: "delivers" when the browser is online and fails like a dropped
 * connection when it is not. Only wired up in builds with NEXT_PUBLIC_OFFLINE_TEST_SENDER=1
 * (the Playwright server), never in production.
 */
export const testSender: QueueSender = {
  async send() {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new TypeError("Failed to fetch");
    }
    return { ok: true };
  },
};
