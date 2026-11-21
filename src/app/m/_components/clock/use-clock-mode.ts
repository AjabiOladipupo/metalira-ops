"use client";

import { liveQuery } from "dexie";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type { QueueDb } from "@/lib/offline/db";
import type { AnyQueueItem } from "@/lib/offline/types";
import { isPunchQueueKind } from "@/lib/punches/clock";

import { useActiveQueue } from "../offline/hooks";

/** The worker's last punch as the server knows it (my_clock_context). */
export interface ServerLastPunch {
  kind: "in" | "out";
  recordedAt: string;
  /** A clock-in from the last 20 hours with no clock-out after it (worked out on the server). */
  open: boolean;
}

export interface LocalPunch {
  kind: "in" | "out";
  /** When it happened, by the phone's clock (ms epoch). */
  deviceTime: number;
}

/** The newest punch still waiting on the phone (queued or sending), or null. */
async function latestPending(db: QueueDb): Promise<LocalPunch | null> {
  const rows = (await db.punchQueue
    .where("status")
    .anyOf(["queued", "sending"])
    .toArray()) as AnyQueueItem[];
  let latest: AnyQueueItem | null = null;
  for (const row of rows) {
    if (!isPunchQueueKind(row.kind)) continue;
    if (!latest || row.created_at > latest.created_at) latest = row;
  }
  if (!latest) return null;
  return { kind: latest.kind === "clock_in" ? "in" : "out", deviceTime: latest.device_time };
}

/**
 * Whether the worker is clocked in: their newest punch still on the phone, else the server's
 * last punch. When the phone's punches have all been sent, the page is refreshed so the server's
 * answer catches up.
 */
export function useClockState(server: ServerLastPunch | null): {
  clockedIn: boolean;
  /** Known once the phone's queue has been read (or there is no queue). */
  ready: boolean;
  /** The punch the state comes from, for "Clocked in at 05:56". */
  since: number | null;
} {
  const queue = useActiveQueue();
  const router = useRouter();
  const [pending, setPending] = useState<LocalPunch | null | undefined>(undefined);
  const hadPending = useRef(false);

  useEffect(() => {
    if (!queue) return;
    const subscription = liveQuery(() => latestPending(queue.db)).subscribe({
      next: (value) => {
        if (hadPending.current && value === null) router.refresh();
        hadPending.current = value !== null;
        setPending(value);
      },
      error: () => setPending(null),
    });
    return () => subscription.unsubscribe();
  }, [queue, router]);

  const local = queue ? pending : null;
  if (local) return { clockedIn: local.kind === "in", ready: true, since: local.deviceTime };
  return {
    clockedIn: server?.open ?? false,
    ready: !queue || local !== undefined,
    since: server ? Date.parse(server.recordedAt) : null,
  };
}
