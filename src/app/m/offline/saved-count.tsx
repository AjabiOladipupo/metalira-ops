"use client";

import { useEffect, useState } from "react";

import { workerMessages } from "@/lib/messages/worker";
import { lastQueueOwner } from "@/lib/offline/active-queue";
import { queueDb, type QueueDb } from "@/lib/offline/db";

import { useQueueCount } from "../_components/offline/hooks";

/**
 * How many punches the last signed-in worker has saved on this phone. The offline page has no
 * session (it is served from the service worker's cache), so it reads the owner the worker app
 * remembered at sign-in.
 */
export function SavedCount() {
  const [db, setDb] = useState<QueueDb | null>(null);
  useEffect(() => {
    const owner = lastQueueOwner();
    if (!owner) return;
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one read of browser state
      setDb(queueDb(owner));
    } catch {
      // Not a valid owner (storage edited by hand): show no count.
    }
  }, []);
  const pending = useQueueCount(db, "pending");
  if (pending === 0) return null;
  return (
    <p className="m-0 text-[15px] font-semibold" data-testid="offline-page-count">
      {workerMessages.offline.saved(pending)}
    </p>
  );
}
