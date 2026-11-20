import Dexie, { type EntityTable } from "dexie";

import type { AnyQueueItem, QueueOwner } from "./types";

/**
 * One IndexedDB database per worker and organisation, so one worker's queue can never be read
 * or sent with another's session on a shared phone. The name holds only the two ids.
 */
export const DB_PREFIX = "metalira-queue";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalise(owner: QueueOwner): QueueOwner {
  if (!UUID.test(owner.organisationId) || !UUID.test(owner.workerId)) {
    throw new Error("Queue owner ids must be UUIDs.");
  }
  return {
    organisationId: owner.organisationId.toLowerCase(),
    workerId: owner.workerId.toLowerCase(),
  };
}

/** The database name for an owner. Throws on anything but two UUIDs. */
export function queueDbName(owner: QueueOwner): string {
  const o = normalise(owner);
  return `${DB_PREFIX}:${o.organisationId}:${o.workerId}`;
}

/** The owner a queue database name belongs to, or null for any other database. */
export function ownerFromDbName(name: string): QueueOwner | null {
  const [prefix, organisationId, workerId, ...rest] = name.split(":");
  if (prefix !== DB_PREFIX || !organisationId || !workerId || rest.length > 0) return null;
  if (!UUID.test(organisationId) || !UUID.test(workerId)) return null;
  return { organisationId, workerId };
}

export class QueueDb extends Dexie {
  punchQueue!: EntityTable<AnyQueueItem, "client_event_id">;
  /** Whose queue this is; every row written here carries these ids. */
  readonly owner: QueueOwner;

  constructor(owner: QueueOwner) {
    super(queueDbName(owner));
    this.owner = normalise(owner);
    // Primary key client_event_id (no auto-increment: the phone makes the id). Indexes for the
    // counts, for picking due items in send order and for the retention clean-up.
    this.version(1).stores({
      punchQueue: "client_event_id, status, created_at, [status+created_at], failed_at",
    });
  }
}

const open = new Map<string, QueueDb>();

/** The owner's queue database, opened once per page. */
export function queueDb(owner: QueueOwner): QueueDb {
  const name = queueDbName(owner);
  let db = open.get(name);
  if (!db) {
    const created = new QueueDb(owner);
    open.set(name, created);
    // Closed here or deleted from another tab (sign-out there): forget this connection.
    created.on("close", () => {
      if (open.get(name) === created) open.delete(name);
    });
    db = created;
  }
  return db;
}

/** Deletes the owner's whole queue (sign-out). */
export async function deleteQueueDb(owner: QueueOwner): Promise<void> {
  const name = queueDbName(owner);
  const db = open.get(name);
  open.delete(name);
  if (db) {
    await db.delete();
  } else {
    await Dexie.delete(name);
  }
}

/** Every queue database on this phone (all owners). Empty where the browser cannot list them. */
export async function listQueueOwners(): Promise<QueueOwner[]> {
  try {
    const names = await Dexie.getDatabaseNames();
    return names.map(ownerFromDbName).filter((o): o is QueueOwner => o !== null);
  } catch {
    return [];
  }
}
