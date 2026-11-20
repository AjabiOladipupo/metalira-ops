"use client";

import { liveQuery } from "dexie";
import { useEffect, useState, useSyncExternalStore } from "react";

import { getActiveQueue, subscribeActiveQueue } from "@/lib/offline/active-queue";
import type { QueueDb } from "@/lib/offline/db";
import { countPending, countUnsent } from "@/lib/offline/queue";

function subscribeOnline(listener: () => void) {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

/** False when the browser says there is no network. Online during server rendering. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine !== false,
    () => true,
  );
}

/** The signed-in worker's open queue, or null (signed out, or before the session loads). */
export function useActiveQueue() {
  return useSyncExternalStore(subscribeActiveQueue, getActiveQueue, () => null);
}

/** Live count of a queue's rows (pending or unsent); 0 with no queue. */
export function useQueueCount(db: QueueDb | null, which: "pending" | "unsent"): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!db) return;
    const subscription = liveQuery(() =>
      which === "pending" ? countPending(db) : countUnsent(db),
    ).subscribe({
      next: (value) => setCount(value),
      error: () => setCount(0),
    });
    return () => {
      subscription.unsubscribe();
      setCount(0);
    };
  }, [db, which]);
  return db ? count : 0;
}
