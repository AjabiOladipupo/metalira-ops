"use client";

import { useEffect } from "react";

import {
  activateQueue,
  deactivateQueue,
  getActiveQueue,
  queueEvent,
} from "@/lib/offline/active-queue";
import { countPending, countUnsent } from "@/lib/offline/queue";
import { setQueueSender, testSender } from "@/lib/offline/senders";
import { createPunchSender } from "@/lib/punches/sender";
import { recordPunchAction, uploadPunchSelfieAction } from "@/server/workforce/punch-actions";
import { requestPersistentStorage } from "@/lib/offline/storage";
import type { QueueOwner } from "@/lib/offline/types";

/** Builds for the Playwright suite only (playwright.config.ts); never set in production. */
const TEST_HOOKS = process.env.NEXT_PUBLIC_OFFLINE_TEST_SENDER === "1";

declare global {
  interface Window {
    /** End-to-end test hooks, present only in NEXT_PUBLIC_OFFLINE_TEST_SENDER=1 builds. */
    __metaliraQueue?: {
      queuePing(note: string): Promise<string>;
      pending(): Promise<number>;
      unsent(): Promise<number>;
    };
  }
}

const punchActions = {
  recordPunch: recordPunchAction,
  uploadSelfie: uploadPunchSelfieAction,
};

function installTestHooks() {
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

/**
 * Opens the signed-in worker's offline queue and starts its sync engine. Rendered by the
 * signed-in worker layout with ids from the verified session, so the queue always belongs to
 * the worker and organisation the server says are signed in. Renders nothing.
 */
export function QueueOwnerSync({ organisationId, workerId }: QueueOwner) {
  useEffect(() => {
    if (TEST_HOOKS) installTestHooks();
    // Punches go to the server through this sender, bound to the queue's owner (slice 3.5). The
    // test build also sends its ping kind through the test sender.
    setQueueSender(
      createPunchSender({ organisationId, workerId }, punchActions, TEST_HOOKS ? testSender : null),
    );
    try {
      activateQueue({ organisationId, workerId });
    } catch {
      // IndexedDB unavailable (some private modes): the app works online without the queue.
      return;
    }
    void requestPersistentStorage();
    return () => {
      deactivateQueue();
      setQueueSender(null);
    };
  }, [organisationId, workerId]);
  return null;
}
