"use client";

import { useEffect, useState } from "react";

import { workerMessages } from "@/lib/messages/worker";
import { getActiveQueue } from "@/lib/offline/active-queue";
import { captureInstallPrompt } from "@/lib/offline/install";
import { isStorageLow, storageEstimate } from "@/lib/offline/storage";
import { DRAIN_MESSAGE } from "@/lib/offline/sync-constants";

import { useActiveQueue, useOnline, useQueueCount } from "./hooks";

const copy = workerMessages.offline;

export const SW_URL = "/sw.js";
export const SW_SCOPE = "/m";

/**
 * The service worker runs in production builds only. `pnpm dev` builds it too, but stale
 * caches during development are confusing, so it needs NEXT_PUBLIC_SW_DEV=1 there.
 */
const SW_ENABLED = process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_SW_DEV === "1";

/**
 * Registers the service worker for /m and reports a waiting update. The new version takes over
 * only when the worker taps reload, never in the middle of a clock-in.
 */
function useServiceWorker(): { waiting: ServiceWorker | null } {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!SW_ENABLED || !("serviceWorker" in navigator)) return;
    let cancelled = false;
    let registration: ServiceWorkerRegistration | null = null;

    const watch = (worker: ServiceWorker | null) => {
      if (!worker) return;
      const check = () => {
        // An installed worker with a controller already in place is an update, not a first visit.
        if (worker.state === "installed" && navigator.serviceWorker.controller && !cancelled) {
          setWaiting(worker);
        }
      };
      check();
      worker.addEventListener("statechange", check);
    };

    const onUpdateFound = () => watch(registration?.installing ?? null);
    const onVisible = () => {
      if (document.visibilityState === "visible") void registration?.update().catch(() => {});
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      const data = event.data as { type?: unknown } | null;
      if (data?.type === DRAIN_MESSAGE) void getActiveQueue()?.engine.sync("background-sync");
    };

    navigator.serviceWorker
      .register(SW_URL, { scope: SW_SCOPE, updateViaCache: "none" })
      .then((reg) => {
        if (cancelled) return;
        registration = reg;
        if (reg.waiting) watch(reg.waiting);
        reg.addEventListener("updatefound", onUpdateFound);
      })
      .catch(() => {
        // No service worker (private mode, old browser): the app still works online.
      });
    navigator.serviceWorker.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      registration?.removeEventListener("updatefound", onUpdateFound);
      navigator.serviceWorker.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return { waiting };
}

function reloadInto(worker: ServiceWorker) {
  navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), {
    once: true,
  });
  worker.postMessage({ type: "SKIP_WAITING" });
}

/** True when the phone is nearly out of space for the site. Checked once per signed-in page. */
function useStorageLow(enabled: boolean): boolean {
  const [low, setLow] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void storageEstimate().then((estimate) => {
      if (!cancelled) setLow(isStorageLow(estimate));
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return enabled && low;
}

/**
 * Connectivity and app-update strip at the top of every /m screen (WkHome and WkClock boards):
 * the black "No network" banner with the count of punches saved on the phone, a quieter line
 * while saved punches are sending, a low-storage warning, and the update prompt.
 */
export function WorkerPwa() {
  const online = useOnline();
  const queue = useActiveQueue();
  const pending = useQueueCount(queue?.db ?? null, "pending");
  const storageLow = useStorageLow(queue !== null);
  const { waiting } = useServiceWorker();

  useEffect(() => {
    captureInstallPrompt();
  }, []);

  return (
    <div className="sticky top-0 z-20 flex flex-col">
      {!online ? (
        <div
          role="status"
          data-testid="offline-banner"
          className="flex flex-col gap-0.5 bg-foreground px-4 py-2.5 text-[13px] text-background"
        >
          <span>{copy.banner}</span>
          {pending > 0 ? (
            <span className="font-semibold" data-testid="offline-count">
              {copy.saved(pending)}
            </span>
          ) : null}
        </div>
      ) : pending > 0 ? (
        <div
          role="status"
          data-testid="sending-banner"
          className="bg-surface px-4 py-2.5 text-[13px] text-foreground"
        >
          {copy.sending(pending)}
        </div>
      ) : null}
      {storageLow ? (
        <div role="alert" className="border-b border-line bg-background px-4 py-2.5 text-[13px]">
          {copy.storageLow}
        </div>
      ) : null}
      {waiting ? (
        <div
          role="status"
          className="flex items-center justify-between gap-3 border-b border-line bg-background px-4 py-2 text-[13px]"
        >
          <span>{copy.updateReady}</span>
          <button
            type="button"
            onClick={() => reloadInto(waiting)}
            className="h-11 shrink-0 rounded-lg px-3 text-[14px] font-semibold underline underline-offset-4"
          >
            {copy.updateReload}
          </button>
        </div>
      ) : null}
    </div>
  );
}
