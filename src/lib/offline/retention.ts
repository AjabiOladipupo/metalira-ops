import Dexie from "dexie";

import { listQueueOwners, QueueDb, queueDb, queueDbName } from "./db";
import { countUnsent } from "./queue";
import { pruneQueue } from "./sync-engine";
import type { QueueOwner } from "./types";

const same = (a: QueueOwner, b: QueueOwner) =>
  a.organisationId.toLowerCase() === b.organisationId.toLowerCase() &&
  a.workerId.toLowerCase() === b.workerId.toLowerCase();

export interface HousekeepingReport {
  /** Rows removed by the retention limits, across all queues. */
  expired: number;
  /** Other owners' queues deleted because nothing in them was unsent. */
  deletedQueues: number;
}

/**
 * Runs when a worker's queue opens (security review M3). Applies the retention limits to every
 * queue on this phone, and deletes other workers' queues that hold nothing unsent, so a shared
 * phone keeps no one else's data longer than it must. Queues with unsent rows are kept for
 * their owner's next sign-in, within the same limits.
 */
export async function housekeepQueues(
  current: QueueOwner,
  now: number,
): Promise<HousekeepingReport> {
  const report: HousekeepingReport = { expired: 0, deletedQueues: 0 };
  report.expired += await pruneQueue(queueDb(current), now);

  for (const owner of await listQueueOwners()) {
    if (same(owner, current)) continue;
    const db = new QueueDb(owner);
    let unsent = 1;
    try {
      report.expired += await pruneQueue(db, now);
      unsent = await countUnsent(db);
    } finally {
      db.close();
    }
    if (unsent === 0) {
      await Dexie.delete(queueDbName(owner));
      report.deletedQueues += 1;
    }
  }
  return report;
}
