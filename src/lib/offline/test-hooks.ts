import { getActiveQueue, queueEvent } from "./active-queue";
import { countPending, countUnsent } from "./queue";
import { setQueueSender } from "./senders";
import type { QueueSender } from "./types";

/**
 * End-to-end test hooks (tests/e2e/offline.spec.ts). Loaded only through a dynamic import in
 * builds with NEXT_PUBLIC_OFFLINE_TEST_SENDER=1 and no NEXT_PUBLIC_VERCEL_ENV, so neither the
 * test sender nor the window hooks are in production bundles (security review M1); the build
 * refuses the flag on Vercel (next.config.ts).
 */

/** "Delivers" when the browser is online; fails like a dropped connection when it is not. */
export const testSender: QueueSender = {
  async send() {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new TypeError("Failed to fetch");
    }
    return { ok: true };
  },
};

declare global {
  interface Window {
    __metaliraQueue?: {
      queuePing(note: string): Promise<string>;
      pending(): Promise<number>;
      unsent(): Promise<number>;
    };
  }
}

export function installTestHooks(): void {
  setQueueSender(testSender);
  window.__metaliraQueue = {
    async queuePing(note) {
      const item = await queueEvent({ kind: "test_ping", payload: { note } });
      return item.client_event_id;
    },
    async pending() {
      const queue = getActiveQueue();
      return queue ? countPending(queue.db) : 0;
    },
    async unsent() {
      const queue = getActiveQueue();
      return queue ? countUnsent(queue.db) : 0;
    },
  };
}
