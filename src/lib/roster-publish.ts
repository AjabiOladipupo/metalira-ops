import { todayIn } from "./dates";
import { inboxMessageSchema, type InboxMessage } from "./inbox";
import { formatShortDay, timeIn } from "./roster";

/**
 * Roster publishing (slice 3.3), the parts shared by the server, the screens and their tests:
 * reading publish_roster's result, the status line, the notice each worker gets, and the
 * "who was told" sentence. No database access here.
 */

export type PublishChangeKind = "added" | "removed" | "changed";

export interface PublishedShift {
  date: string;
  startsAt: string;
  endsAt: string;
  postName: string;
}

export interface AffectedWorker {
  workerId: string;
  workerName: string;
  kind: PublishChangeKind;
  /** Their shifts at this site that week in the new version (none when taken off them all). */
  shifts: PublishedShift[];
}

export interface PublishResult {
  publicationId: string | null;
  version: number;
  previousVersion: number | null;
  publishedAt: string | null;
  siteId: string;
  siteName: string;
  timeZone: string;
  weekStart: string;
  assigned: number;
  open: number;
  dryRun: boolean;
  nothingChanged: boolean;
  counts: Record<PublishChangeKind, number>;
  affected: AffectedWorker[];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const num = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const KINDS: readonly PublishChangeKind[] = ["added", "removed", "changed"];

/** publish_roster's jsonb, typed. */
export function toPublishResult(value: unknown): PublishResult {
  const r = record(value);
  const counts = record(r.counts);
  const affected = Array.isArray(r.affected) ? r.affected : [];
  return {
    publicationId: typeof r.publication_id === "string" ? r.publication_id : null,
    version: num(r.version),
    previousVersion: r.previous_version == null ? null : num(r.previous_version),
    publishedAt: typeof r.published_at === "string" ? r.published_at : null,
    siteId: str(r.site_id),
    siteName: str(r.site_name),
    timeZone: str(r.time_zone, "Africa/Lagos"),
    weekStart: str(r.week_start),
    assigned: num(r.assigned),
    open: num(r.open),
    dryRun: r.dry_run === true,
    nothingChanged: r.nothing_changed === true,
    counts: {
      added: num(counts.added),
      removed: num(counts.removed),
      changed: num(counts.changed),
    },
    affected: affected.map((item) => {
      const a = record(item);
      const kind = KINDS.find((k) => k === a.kind) ?? "changed";
      const shifts = Array.isArray(a.shifts) ? a.shifts : [];
      return {
        workerId: str(a.worker_id),
        workerName: str(a.worker_name),
        kind,
        shifts: shifts.map((s) => {
          const x = record(s);
          return {
            date: str(x.shift_date),
            startsAt: str(x.starts_at),
            endsAt: str(x.ends_at),
            postName: str(x.post_name),
          };
        }),
      };
    }),
  };
}

export interface PublicationStatus {
  version: number | null;
  publishedAt: string | null;
  assigned: number;
  open: number;
  /** People whose shifts differ from the latest version. */
  workersAffected: number;
  /** `${postId}|${date}` for each post-day that changed since the latest version. */
  changed: string[];
}

/** roster_publication_status's jsonb, typed. */
export function toPublicationStatus(value: unknown): PublicationStatus {
  const r = record(value);
  const changed = Array.isArray(r.changed) ? r.changed : [];
  return {
    version: r.version == null ? null : num(r.version),
    publishedAt: typeof r.published_at === "string" ? r.published_at : null,
    assigned: num(r.assigned),
    open: num(r.open),
    workersAffected: num(r.workers_affected),
    changed: changed.map((c) => {
      const x = record(c);
      return `${str(x.post_id)}|${str(x.shift_date)}`;
    }),
  };
}

/** "23 Nov". */
export function dayMonth(iso: string): string {
  return formatShortDay(iso).split(" ").slice(1).join(" ");
}

/** "21 Nov 14:05" in the company's time zone. */
export function formatPublishedAt(at: string, timeZone: string): string {
  const date = new Date(at);
  return `${dayMonth(todayIn(timeZone, date))} ${timeIn(at, timeZone)}`;
}

/** "Published · version 2 · 21 Nov 14:05", or "Not published". */
export function formatPublicationStatus(
  status: Pick<PublicationStatus, "version" | "publishedAt">,
  timeZone: string,
): string {
  if (status.version === null || !status.publishedAt) return "Not published";
  return `Published · version ${status.version} · ${formatPublishedAt(status.publishedAt, timeZone)}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 added, 1 taken off, 1 with changed shifts", for the confirm step. */
export function formatChangeCounts(counts: Record<PublishChangeKind, number>): string {
  const parts = [
    counts.added > 0 ? `${plural(counts.added, "worker", "workers")} added` : null,
    counts.removed > 0 ? `${plural(counts.removed, "worker", "workers")} taken off` : null,
    counts.changed > 0
      ? `${plural(counts.changed, "worker", "workers")} with changed shifts`
      : null,
  ].filter((p): p is string => p !== null);
  return parts.length ? parts.join(", ") : "No changes for anyone";
}

// ---------------------------------------------------------------------------
// The notice each affected worker gets
// ---------------------------------------------------------------------------

/** Lines of shifts listed in one notice; the rest are counted ("and 3 more"). */
export const NOTICE_MAX_LINES = 10;

/** Plain text for a notice: no control characters or angle brackets, one line, trimmed. */
function clean(text: string, max: number): string {
  const plain = text
    .replace(/[\p{Cc}<>]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/** "Mon 23 Nov 06:00–18:00 Gate A · Day". */
export function noticeLine(shift: PublishedShift, timeZone: string): string {
  return `${formatShortDay(shift.date)} ${timeIn(shift.startsAt, timeZone)}–${timeIn(shift.endsAt, timeZone)} ${clean(shift.postName, 60)}`;
}

/**
 * The inbox item (and email) for one worker after a publish: their shifts at the site that week,
 * one line each. A republish says the shifts changed; a worker taken off every shift is told so.
 * Always passes the inbox rules (src/lib/inbox.ts): when a post or site name would break them
 * (a web address, or a run of 10 or more digits), the notice falls back to a sentence without
 * names that points to My shifts.
 */
export function buildShiftNotice(input: {
  siteName: string;
  weekStart: string;
  timeZone: string;
  republish: boolean;
  shifts: PublishedShift[];
}): InboxMessage {
  const week = dayMonth(input.weekStart);
  const site = clean(input.siteName, 80) || "your site";
  const title = input.republish
    ? `Your shifts changed for the week of ${week}`
    : `Your shifts for the week of ${week}`;
  const link = "/m/shifts";
  const kind = "shift_published";

  let body: string;
  if (input.shifts.length === 0) {
    body = `You are no longer on any shift at ${site} in the week of ${week}.`;
  } else {
    const sorted = [...input.shifts].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const lines = sorted.slice(0, NOTICE_MAX_LINES).map((s) => noticeLine(s, input.timeZone));
    const more = sorted.length - lines.length;
    body = [
      `At ${site}:`,
      ...lines,
      ...(more > 0 ? [`and ${more} more`] : []),
      "Open My shifts for the details.",
    ].join("\n");
  }

  const message: InboxMessage = { kind, title, body, link };
  if (inboxMessageSchema.safeParse(message).success) return message;
  return {
    kind,
    title,
    body:
      input.shifts.length === 0
        ? `Your shifts for the week of ${week} changed. Open My shifts to see them.`
        : `Your shifts for the week of ${week} are ready. Open My shifts to see them.`,
    link,
  };
}

// ---------------------------------------------------------------------------
// Who was told
// ---------------------------------------------------------------------------

export interface NotifyTally {
  /** Inbox items added. */
  inApp: number;
  emailed: number;
  /** Emails held back by the daily caps. */
  capped: number;
  /** Workers with no email address (told in the app only). */
  noEmail: number;
  /** Emails that failed to send (the inbox item is there). */
  emailFailed: number;
  /** Workers not told at all: their inbox item couldn't be added. "Send notices again" retries. */
  failed: number;
}

export const EMPTY_TALLY: NotifyTally = {
  inApp: 0,
  emailed: 0,
  capped: 0,
  noEmail: 0,
  emailFailed: 0,
  failed: 0,
};

/** "3 workers told in the app, 2 by email, 1 email held back by the daily limit". */
export function formatNotifyTally(tally: NotifyTally): string {
  if (tally.inApp === 0 && tally.failed === 0) return "No one needed telling";
  const parts = [`${plural(tally.inApp, "worker", "workers")} told in the app`];
  parts.push(`${tally.emailed} by email`);
  if (tally.capped > 0) {
    parts.push(`${plural(tally.capped, "email", "emails")} held back by the daily limit`);
  }
  if (tally.emailFailed > 0) {
    parts.push(`${plural(tally.emailFailed, "email", "emails")} failed to send`);
  }
  if (tally.failed > 0) parts.push(`${plural(tally.failed, "worker", "workers")} not told yet`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// The worker home card
// ---------------------------------------------------------------------------

/**
 * Today's shifts for the home card: those starting today, and last night's while it is still
 * running. The one to show first is the earliest not yet over, else the first of the day.
 */
export function pickShiftsToday<T extends { date: string; endsAt: string }>(
  shifts: readonly T[],
  today: string,
  nowMs: number,
): { shift: T | null; more: number } {
  const current = shifts.filter(
    (s) => s.date === today || (s.date < today && Date.parse(s.endsAt) > nowMs),
  );
  const shift = current.find((s) => Date.parse(s.endsAt) > nowMs) ?? current[0] ?? null;
  return { shift, more: Math.max(current.length - 1, 0) };
}
