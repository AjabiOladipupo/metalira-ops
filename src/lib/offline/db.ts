import Dexie, { type EntityTable } from "dexie";

import type { AnyQueueItem, QueueOwner } from "./types";

/**
 * One IndexedDB database per worker and organisation, so one worker's queue can never be read
 * or sent with another's session on a shared phone. The name holds only the two ids.
 */
const DB_PREFIX = "metalira-queue";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The database name for an owner. Throws on anything but two UUIDs. */
export function queueDbName(owner: QueueOwner): string {
  if (!UUID.test(owner.organisationId) || !UUID.test(owner.workerId)) {
    throw new Error("Queue owner ids must be UUIDs.");
  }
  return `${DB_PREFIX}:${owner.organisationId.toLowerCase()}:${owner.workerId.toLowerCase()}`;
}

export class QueueDb extends Dexie {
  punchQueue!: EntityTable<AnyQueueItem, "client_event_id">;

  constructor(name: string) {
    super(name);
    // Primary key client_event_id (no auto-increment: the phone makes the id). Indexes for the
    // pending count and for picking due items in send order.
    this.version(1).stores({
      punchQueue: "client_event_id, status, created_at, [status+created_at]",
    });
  }
}

const open = new Map<string, QueueDb>();

/** The owner's queue database, opened once per page. */
export function queueDb(owner: QueueOwner): QueueDb {
  const name = queueDbName(owner);
  let db = open.get(name);
  if (!db) {
    db = new QueueDb(name);
    open.set(name, db);
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
