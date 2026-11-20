import "server-only";

import {
  buildShiftNotice,
  EMPTY_TALLY,
  type NotifyTally,
  type PublishResult,
} from "@/lib/roster-publish";

import { AlreadyNotifiedError, notifyWorker } from "./notify";

/**
 * Tells each worker affected by a roster publish (slice 3.3): one inbox item per worker per
 * publish, with their shifts at the site that week, and an email under notifyWorker's caps (30 a
 * company, 80 overall in 24 hours). Rule 8: in-app and email only.
 *
 * Call it only with a result from publishRosterSpec: `organisationId` is the verified session's,
 * and the worker ids come from publish_roster, which reads them from the organisation's own
 * assignments. On a republish only the workers whose shifts changed are in `affected`.
 * A failure for one worker is counted and never stops the others; the publish itself is already
 * saved. Logs carry error names only.
 */

const CONCURRENCY = 4;

export async function notifyPublishedRoster(
  organisationId: string,
  result: PublishResult,
): Promise<NotifyTally> {
  const tally: NotifyTally = { ...EMPTY_TALLY };
  const queue = [...result.affected];
  const republish = (result.previousVersion ?? 0) > 0;

  async function worker() {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const message = buildShiftNotice({
        siteName: result.siteName,
        weekStart: result.weekStart,
        timeZone: result.timeZone,
        republish,
        shifts: next.shifts,
      });
      try {
        const sent = await notifyWorker(
          organisationId,
          next.workerId,
          message,
          result.publicationId ? { rosterPublicationId: result.publicationId } : {},
        );
        tally.inApp += 1;
        if (sent.email === "sent") tally.emailed += 1;
        else if (sent.email === "skipped_cap") tally.capped += 1;
        else if (sent.email === "failed") tally.emailFailed += 1;
        else tally.noEmail += 1;
      } catch (error) {
        // Told already for this version (a resend raced another): nothing to count.
        if (error instanceof AlreadyNotifiedError) continue;
        tally.failed += 1;
        console.error(
          "roster.notify_failed:",
          error instanceof Error ? error.name : "unknown error",
        );
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return tally;
}
