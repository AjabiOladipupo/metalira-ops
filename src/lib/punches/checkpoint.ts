import { z } from "zod";

import { WORKER_CHECKPOINT_PATH } from "@/lib/auth/routes";

/**
 * Patrol checkpoint scans (slice 3.8). A checkpoint's QR code opens /m/checkpoint#<token>
 * (src/server/sites/sites-data.ts `checkpointUrl`). The token sits in the URL fragment, which
 * the browser never sends to the server, so it never reaches a request log; the scan page reads
 * it on the phone and saves the scan in the offline queue. Isomorphic, no React.
 */

/** The scan page. The printed codes point here. */
export const CHECKPOINT_SCAN_PATH = WORKER_CHECKPOINT_PATH;

/** A checkpoint token as the database makes it: 32 random bytes in lowercase hex. */
export const CHECKPOINT_TOKEN = /^[0-9a-f]{64}$/;

/**
 * The checkpoint token in a URL fragment (`location.hash`), or null. Accepts `#<token>` and the
 * bare token, trims stray spaces and a trailing slash some scanner apps add, and lowercases hex.
 * Anything else (a query string, a path, extra characters, a second token) is refused: the page
 * then asks for the code to be scanned again rather than guessing.
 */
export function parseCheckpointFragment(hash: string | null | undefined): string | null {
  if (typeof hash !== "string") return null;
  let value = hash.trim();
  if (value.startsWith("#")) value = value.slice(1);
  value = value.trim().replace(/\/$/, "");
  if (value.length !== 64) return null;
  const token = value.toLowerCase();
  return CHECKPOINT_TOKEN.test(token) ? token : null;
}

/** One scan as the phone queues it (`checkpoint_scan` in the offline queue). */
export const checkpointScanPayloadSchema = z.object({
  token: z.string().regex(CHECKPOINT_TOKEN),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  accuracy_m: z.number().min(0).max(1_000_000).nullable(),
  /**
   * Saved with no live session: offline, under the phone's last signed-in worker. The server
   * flags the scan `queued_offline` for review (slice 3.8 review L2).
   */
  queued_offline: z.boolean().default(false),
});

export type CheckpointScanPayload = z.output<typeof checkpointScanPayloadSchema>;

declare module "@/lib/offline/types" {
  interface QueuePayloads {
    checkpoint_scan: CheckpointScanPayload;
  }
}

export const CHECKPOINT_QUEUE_KIND = "checkpoint_scan" as const;

export function isCheckpointQueueKind(kind: string): kind is typeof CHECKPOINT_QUEUE_KIND {
  return kind === CHECKPOINT_QUEUE_KIND;
}

/** What the done screen shows once the server has a scan (never the token). */
export interface ScanReceipt {
  checkpointName: string | null;
  siteName: string | null;
  recordedAt: string;
  geofence: "inside" | "near" | "outside" | "unknown";
  flags: string[];
}

/** The server's answer to a scan sent from this page: a receipt, or a fixed refusal code. */
export type ScanOutcome = { ok: true; receipt: ScanReceipt } | { ok: false; code: string };

/**
 * Answers to scans sent from this page, by client_event_id, so the done screen can say which
 * checkpoint the server matched, or why it refused. In memory only: never written to the phone's
 * storage (the queue keeps only its own fixed codes).
 */
const outcomes = new Map<string, ScanOutcome>();
const listeners = new Set<() => void>();

export function rememberScanOutcome(clientEventId: string, outcome: ScanOutcome): void {
  outcomes.set(clientEventId, outcome);
  if (outcomes.size > 50) {
    const oldest = outcomes.keys().next().value;
    if (oldest !== undefined) outcomes.delete(oldest);
  }
  for (const listener of listeners) listener();
}

export function scanOutcome(clientEventId: string): ScanOutcome | null {
  return outcomes.get(clientEventId) ?? null;
}

export function subscribeScanOutcomes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The phone-side record that the worker agreed to location (a yes/no only, per worker). */
export function locationConsentKey(workerId: string): string {
  return `metalira.locationConsent.${workerId.toLowerCase()}`;
}
