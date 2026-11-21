"use client";

import { liveQuery } from "dexie";
import { ArrowDownToLine, Check, MapPinOff } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { getActiveQueue, lastQueueOwner, queueEvent } from "@/lib/offline/active-queue";
import { queueDb, type QueueDb } from "@/lib/offline/db";
import { enqueue } from "@/lib/offline/queue";
import type { QueueOwner, QueueStatus } from "@/lib/offline/types";
import { workerMessages } from "@/lib/messages/worker";
import {
  locationConsentKey,
  parseCheckpointFragment,
  scanOutcome,
  subscribeScanOutcomes,
  type CheckpointScanPayload,
} from "@/lib/punches/checkpoint";
import { timeIn } from "@/lib/roster";
import { checkpointScanContextAction } from "@/server/workforce/checkpoint-scan-actions";

import { QueueOwnerSync } from "../offline/queue-owner";
import { useOnline } from "../offline/hooks";

const copy = workerMessages.checkpoint;
const LAGOS = "Africa/Lagos";

interface Fix {
  lat: number;
  lng: number;
  accuracy: number;
}

/** Whose queue the scan goes in, and whether this page has that worker's session. */
interface ScanOwner extends QueueOwner {
  /** The verified login, when the server answered; null when offline (the last owner). */
  userId: string | null;
}

type Phase =
  | { name: "starting" }
  | { name: "blocked"; message: string; action?: { href: string; label: string } }
  | { name: "locating" }
  | { name: "location_failed"; failure: "denied" | "timeout" }
  | { name: "done"; id: string; db: QueueDb; at: number; hasLocation: boolean; live: boolean };

function locate(): Promise<{ fix: Fix } | { failure: "denied" | "timeout" }> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) {
      resolve({ failure: "denied" });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          fix: {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: Math.max(0, Math.round(position.coords.accuracy)),
          },
        }),
      (error) =>
        resolve({ failure: error.code === error.PERMISSION_DENIED ? "denied" : "timeout" }),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  });
}

function readConsentFlag(workerId: string): boolean {
  try {
    return localStorage.getItem(locationConsentKey(workerId)) === "1";
  } catch {
    return false;
  }
}

function writeConsentFlag(workerId: string, agreed: boolean): void {
  try {
    localStorage.setItem(locationConsentKey(workerId), agreed ? "1" : "0");
  } catch {
    // Storage blocked: offline scans then ask to agree again.
  }
}

const sameOwner = (a: QueueOwner, b: QueueOwner) =>
  a.organisationId.toLowerCase() === b.organisationId.toLowerCase() &&
  a.workerId.toLowerCase() === b.workerId.toLowerCase();

/**
 * Saves the scan on the phone: in the open queue when it is this worker's (it sends straight
 * away), else straight into the owner's queue database, which drains the next time the worker
 * opens the app signed in.
 */
async function saveScan(
  owner: QueueOwner,
  payload: CheckpointScanPayload,
): Promise<{ id: string; db: QueueDb; at: number }> {
  const active = getActiveQueue();
  if (active && sameOwner(active.owner, owner)) {
    const item = await queueEvent({ kind: "checkpoint_scan", payload });
    return { id: item.client_event_id, db: active.db, at: item.device_time };
  }
  const db = queueDb(owner);
  const item = await enqueue(db, { kind: "checkpoint_scan", payload });
  return { id: item.client_event_id, db, at: item.device_time };
}

/** The queued scan's state: queued, sending, refused, or gone (sent and deleted). */
function useScanStatus(db: QueueDb, id: string): QueueStatus | "gone" | "loading" {
  const [status, setStatus] = useState<QueueStatus | "gone" | "loading">("loading");
  useEffect(() => {
    const subscription = liveQuery(() => db.punchQueue.get(id)).subscribe({
      next: (item) => setStatus(item?.status ?? "gone"),
      error: () => setStatus("loading"),
    });
    return () => subscription.unsubscribe();
  }, [db, id]);
  return status;
}

function refusalLine(code: string | null): string {
  const refused = copy.refused as Record<string, string>;
  return (code && refused[code]) || copy.refused.other;
}

function DoneScreen({ phase }: { phase: Extract<Phase, { name: "done" }> }) {
  const online = useOnline();
  const status = useScanStatus(phase.db, phase.id);
  const outcome = useSyncExternalStore(
    subscribeScanOutcomes,
    () => scanOutcome(phase.id),
    () => null,
  );
  const receipt = outcome?.ok ? outcome.receipt : null;
  const time = timeIn(new Date(phase.at).toISOString(), LAGOS);

  let line: string;
  if (status === "gone") line = copy.sent;
  else if (status === "failed_permanent") line = refusalLine(outcome && !outcome.ok ? outcome.code : null);
  else if (!phase.live) line = copy.savedForLater;
  else if (!online || status === "loading") line = copy.savedOffline;
  else line = copy.sending;

  const refused = status === "failed_permanent";
  const outside = receipt?.geofence === "outside" || receipt?.geofence === "near";
  const note = refused
    ? null
    : !phase.hasLocation
      ? copy.noLocationNote
      : outside
        ? copy.outsideNote
        : copy.nextScan;

  return (
    <div className="flex flex-1 flex-col justify-center gap-4 px-4 pb-6" data-testid="checkpoint-done">
      <span className="flex size-[72px] items-center justify-center rounded-full bg-foreground text-background">
        {refused ? (
          <MapPinOff strokeWidth={2} className="size-9" aria-hidden />
        ) : (
          <Check strokeWidth={2} className="size-9" aria-hidden />
        )}
      </span>
      <h1 className="m-0 font-display text-[34px] leading-[1.1] font-bold">
        {copy.scannedAt(time)}
      </h1>
      {receipt?.checkpointName ? (
        <p className="m-0 text-lg font-semibold" data-testid="checkpoint-where">
          {copy.where(receipt.checkpointName, receipt.siteName)}
        </p>
      ) : null}
      <p
        role="status"
        data-testid="checkpoint-status"
        data-status={status}
        className="m-0 flex items-center gap-2 text-base"
      >
        <ArrowDownToLine strokeWidth={1.75} className="size-5 shrink-0" aria-hidden />
        {line}
      </p>
      {note ? <p className="m-0 text-[15px] text-fg-muted">{note}</p> : null}
      <Link
        href="/m"
        className="mt-3 flex h-[52px] items-center justify-center rounded-xl border border-foreground text-base font-semibold text-foreground no-underline hover:bg-surface hover:text-foreground"
      >
        {copy.backHome}
      </Link>
    </div>
  );
}

/**
 * The page a checkpoint's QR code opens (slice 3.8). It reads the token from the URL fragment
 * once and takes it out of the address bar, asks the server who is signed in (or, with no
 * network, uses the phone's last signed-in worker), reads the location when the worker has
 * agreed to it, and saves the scan in that worker's offline queue. The server decides
 * everything that counts: the checkpoint, the shift, the time, inside or outside.
 */
export function CheckpointScan() {
  const [phase, setPhase] = useState<Phase>({ name: "starting" });
  const [owner, setOwner] = useState<ScanOwner | null>(null);
  const token = useRef<string | null>(null);
  const started = useRef(false);

  const save = useCallback(async (scanOwner: ScanOwner, fix: Fix | null) => {
    if (!token.current) return;
    try {
      const saved = await saveScan(scanOwner, {
        token: token.current,
        latitude: fix?.lat ?? null,
        longitude: fix?.lng ?? null,
        accuracy_m: fix?.accuracy ?? null,
      });
      setPhase({
        name: "done",
        ...saved,
        hasLocation: fix !== null,
        // With the worker's session the page's queue drains it now (QueueOwnerSync).
        live: scanOwner.userId !== null,
      });
    } catch {
      setPhase({ name: "blocked", message: copy.noQueue });
    }
  }, []);

  const findAndSave = useCallback(
    async (scanOwner: ScanOwner) => {
      setPhase({ name: "locating" });
      const result = await locate();
      if ("fix" in result) await save(scanOwner, result.fix);
      else setPhase({ name: "location_failed", failure: result.failure });
    },
    [save],
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // Read the token once, then take it out of the address bar and the history entry.
    token.current = parseCheckpointFragment(window.location.hash);
    if (window.location.hash) {
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
    }
    if (!token.current) {
      setPhase({ name: "blocked", message: copy.noCode });
      return;
    }

    void (async () => {
      let context: Awaited<ReturnType<typeof checkpointScanContextAction>> | null = null;
      try {
        context = await checkpointScanContextAction();
      } catch {
        context = null;
      }

      if (context === null) {
        // No network: the scan goes in the last signed-in worker's queue on this phone, and is
        // sent only once that worker's own session is back (the queue's owner check).
        const last = lastQueueOwner();
        if (!last) {
          setPhase({ name: "blocked", message: copy.offlineNoOwner });
          return;
        }
        const offlineOwner: ScanOwner = { ...last, userId: null };
        setOwner(offlineOwner);
        if (!readConsentFlag(last.workerId)) {
          setPhase({
            name: "blocked",
            message: `${copy.consentTitle}. ${copy.consentLine}`,
          });
          return;
        }
        await findAndSave(offlineOwner);
        return;
      }

      if (!context.ok) {
        if (context.code === "signed_out") {
          setPhase({
            name: "blocked",
            message: copy.signedOut,
            action: { href: "/m/sign-in", label: copy.signIn },
          });
        } else {
          setPhase({
            name: "blocked",
            message: context.code === "not_worker" ? copy.notWorker : copy.failed,
          });
        }
        return;
      }

      writeConsentFlag(context.workerId, context.locationConsent);
      if (context.left) {
        setPhase({ name: "blocked", message: copy.left });
        return;
      }
      if (!context.shiftsEnabled) {
        setPhase({ name: "blocked", message: copy.shiftsOff });
        return;
      }
      const signedIn: ScanOwner = {
        organisationId: context.organisationId,
        workerId: context.workerId,
        userId: context.userId,
      };
      setOwner(signedIn);
      if (!context.locationConsent) {
        setPhase({
          name: "blocked",
          message: `${copy.consentTitle}. ${copy.consentLine}`,
          action: { href: "/m/clock", label: copy.openClock },
        });
        return;
      }
      await findAndSave(signedIn);
    })();
  }, [findAndSave]);

  return (
    <div className="flex flex-1 flex-col" data-testid="checkpoint-scan" data-phase={phase.name}>
      {owner?.userId ? (
        <QueueOwnerSync
          organisationId={owner.organisationId}
          workerId={owner.workerId}
          userId={owner.userId}
        />
      ) : null}

      {phase.name === "starting" || phase.name === "locating" ? (
        <div className="flex flex-1 flex-col justify-center gap-3 px-4 pb-6" role="status">
          <span
            aria-hidden
            className="size-12 animate-spin rounded-full border-4 border-line border-t-foreground motion-reduce:animate-none"
          />
          <h1 className="m-0 font-display text-[25px] leading-tight font-bold">
            {phase.name === "starting" ? copy.checking : copy.locating}
          </h1>
          {phase.name === "locating" ? (
            <p className="m-0 text-[15px] text-fg-muted">{copy.locatingHint}</p>
          ) : null}
        </div>
      ) : null}

      {phase.name === "blocked" ? (
        <div className="flex flex-1 flex-col justify-center gap-4 px-4 pb-6">
          <p className="m-0 text-base" data-testid="checkpoint-blocked">
            {phase.message}
          </p>
          {phase.action ? (
            <Button asChild className="h-12 rounded-xl text-base">
              <Link href={phase.action.href} prefetch={false}>
                {phase.action.label}
              </Link>
            </Button>
          ) : null}
          <Link href="/m" className="text-[15px]">
            {copy.backHome}
          </Link>
        </div>
      ) : null}

      {phase.name === "location_failed" && owner ? (
        <div className="flex flex-1 flex-col justify-center gap-4 px-4 pb-6">
          <h1 className="m-0 font-display text-[25px] leading-tight font-bold">
            {copy.locationFailedTitle}
          </h1>
          <p className="m-0 text-[15px]">
            {phase.failure === "denied" ? copy.locationDenied : copy.locationTimeout}
          </p>
          <Button className="h-12 rounded-xl text-base" onClick={() => void findAndSave(owner)}>
            {copy.tryAgain}
          </Button>
          <Button
            variant="outline"
            className="h-12 rounded-xl text-base"
            onClick={() => void save(owner, null)}
          >
            {copy.sendWithoutLocation}
          </Button>
        </div>
      ) : null}

      {phase.name === "done" ? <DoneScreen phase={phase} /> : null}
    </div>
  );
}
