import { deleteQueueDb, queueDb, type QueueDb } from "./db";
import { enqueue, type EnqueueInput } from "./queue";
import { housekeepQueues } from "./retention";
import { getQueueSender, onQueueSenderChange } from "./senders";
import { BACKGROUND_SYNC_TAG } from "./sync-constants";
import { SyncEngine } from "./sync-engine";
import type { QueueItem, QueueKind, QueueOwner } from "./types";

/**
 * The signed-in worker's queue in this page: which database is open and the sync engine that
 * drains it. Browser-only. The worker app sets the owner from the verified session (the server
 * renders the ids into the page); nothing here trusts ids from anywhere else.
 */

/** The last signed-in owner, so the offline page (no session) can count their saved items. */
const LAST_OWNER_KEY = "metalira.queueOwner";

export interface ActiveQueue {
  owner: QueueOwner;
  db: QueueDb;
  engine: SyncEngine;
}

export interface ActivateOptions {
  /**
   * True while the browser's session is still this owner's (security review M2). Checked
   * before every drain, so a tab left open after another worker signs in on the same phone
   * never sends this worker's punches with the other session.
   */
  isOwnerSignedIn?: () => boolean | Promise<boolean>;
}

let active: ActiveQueue | null = null;
let stopSenderWatch: (() => void) | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeActiveQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getActiveQueue(): ActiveQueue | null {
  return active;
}

const sameOwner = (a: QueueOwner, b: QueueOwner) =>
  a.organisationId.toLowerCase() === b.organisationId.toLowerCase() &&
  a.workerId.toLowerCase() === b.workerId.toLowerCase();

function saveLastOwner(owner: QueueOwner | null) {
  try {
    if (owner) localStorage.setItem(LAST_OWNER_KEY, JSON.stringify(owner));
    else localStorage.removeItem(LAST_OWNER_KEY);
  } catch {
    // Private mode or storage blocked: the offline page just shows no count.
  }
}

/** The last signed-in owner on this phone, or null. */
export function lastQueueOwner(): QueueOwner | null {
  try {
    const raw = localStorage.getItem(LAST_OWNER_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<QueueOwner>;
    return typeof value.organisationId === "string" && typeof value.workerId === "string"
      ? { organisationId: value.organisationId, workerId: value.workerId }
      : null;
  } catch {
    return null;
  }
}

/**
 * Opens the worker's queue and starts draining it. Switching owner stops the old engine.
 * Also applies the retention limits to every queue on the phone (types.ts): other workers'
 * queues with nothing unsent are deleted.
 */
export function activateQueue(owner: QueueOwner, options: ActivateOptions = {}): ActiveQueue {
  if (active && sameOwner(active.owner, owner)) return active;
  deactivateQueue();
  const db = queueDb(owner);
  const engine = new SyncEngine({
    db,
    getSender: getQueueSender,
    ...(options.isOwnerSignedIn ? { isOwnerSignedIn: options.isOwnerSignedIn } : {}),
  });
  const current: ActiveQueue = { owner: db.owner, db, engine };
  active = current;

  // Deleted or upgraded from another tab (a sign-out there), or closed: stop using it here.
  const release = () => {
    if (active === current) deactivateQueue();
  };
  db.on("versionchange", release);
  db.on("close", release);

  saveLastOwner(db.owner);
  void housekeepQueues(db.owner, Date.now()).catch(() => {});
  engine.start();
  stopSenderWatch = onQueueSenderChange(() => void engine.sync("manual"));
  emit();
  return current;
}

/** Stops the engine (leaving the signed-in screens). The queue stays on the phone. */
export function deactivateQueue(): void {
  stopSenderWatch?.();
  stopSenderWatch = null;
  active?.engine.stop();
  active = null;
  emit();
}

/** Asks the service worker for a Background Sync, where the browser has it (not iOS). */
async function requestBackgroundSync(): Promise<void> {
  try {
    if (!("serviceWorker" in navigator)) return;
    const registration = (await navigator.serviceWorker.getRegistration("/m")) as
      (ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }) | undefined;
    await registration?.sync?.register(BACKGROUND_SYNC_TAG);
  } catch {
    // Progressive enhancement only: the engine still drains on online, focus and the timer.
  }
}

/**
 * Saves an event for the signed-in worker and tries to send it straight away. Resolves once
 * the event is safely on the phone, whether or not it was sent.
 */
export async function queueEvent<K extends QueueKind>(
  input: EnqueueInput<K>,
): Promise<QueueItem<K>> {
  if (!active) throw new Error("No signed-in worker queue.");
  const item = await enqueue(active.db, input);
  void active.engine.sync("manual");
  void requestBackgroundSync();
  return item;
}

/**
 * Signs-out clean-up: stops the engine and deletes the worker's queue from the phone. The
 * caller warns first when unsent items would be lost.
 */
export async function clearQueue(owner: QueueOwner): Promise<void> {
  if (active && sameOwner(active.owner, owner)) deactivateQueue();
  await deleteQueueDb(owner);
  const last = lastQueueOwner();
  if (last && sameOwner(last, owner)) saveLastOwner(null);
}
