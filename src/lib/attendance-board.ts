import { LATE_GRACE, NO_SHOW_AFTER } from "@/lib/attendance";
import { maskPhone } from "@/lib/mask";
import { PUNCH_FLAGS, PUNCH_FLAG_LABELS, type PunchFlag, type PunchKind } from "@/lib/punches/flags";
import { formatShiftHours, timeIn } from "@/lib/roster";

/**
 * The live attendance board (slice 3.7). Pure and browser-safe.
 *
 * The database works the status out on read (`private.attendance_status` in migration
 * 20261120210000); `attendanceStatus` mirrors it for the unit tests, and tests/rls checks the
 * two agree. Owner decision 3 (20 Nov 2026): late after the grace period (10 minutes by default),
 * no-show after `no_show_after_minutes` (60 by default), both company settings.
 */

export const ATTENDANCE_STATUSES = [
  "on_site",
  "late",
  "no_show",
  "starting",
  "clocked_out",
] as const;

export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** How far ahead the board looks for shifts that are about to start. */
export const STARTING_WINDOW_MINUTES = 120;

/** How often the screen asks again. No cron: the board is worked out on each read. */
export const BOARD_POLL_MS = 30_000;

/** Tile labels, in the order the tiles show (the prototype board). */
export const STATUS_TILE_LABELS: Record<AttendanceStatus, string> = {
  on_site: "On site",
  late: "Late",
  no_show: "No-show",
  starting: "Starting in 2 h",
  clocked_out: "Clocked out",
};

/** List headings for each tile. */
export const STATUS_LIST_TITLES: Record<AttendanceStatus, string> = {
  on_site: "On site now",
  late: "Late now",
  no_show: "No-shows",
  starting: "Starting in the next 2 hours",
  clocked_out: "Clocked out today",
};

export interface StatusInput {
  /** ms since the epoch. */
  now: number;
  startsAt: number;
  endsAt: number;
  lateGraceMinutes: number;
  noShowAfterMinutes: number;
  /** The kind of the worker's latest punch on this shift, or null with none. */
  lastPunchKind: PunchKind | null;
}

/**
 * The status of one rostered worker at `now` (mirrors private.attendance_status):
 * - clocked_out: the latest punch on the shift is a clock-out;
 * - on_site: the latest punch is a clock-in (however late it was);
 * - no_show: no clock-in, and the shift has ended or more than the no-show minutes have passed;
 * - late: no clock-in, and more than the grace minutes have passed;
 * - starting: no clock-in yet, before the start or within the grace period.
 * Exactly at the end of the grace period is still on time, as for the punches' late flag.
 */
export function attendanceStatus(input: StatusInput): AttendanceStatus {
  if (input.lastPunchKind === "out") return "clocked_out";
  if (input.lastPunchKind === "in") return "on_site";
  if (input.now >= input.endsAt) return "no_show";
  const sinceStart = input.now - input.startsAt;
  if (sinceStart > input.noShowAfterMinutes * 60_000) return "no_show";
  if (sinceStart > input.lateGraceMinutes * 60_000) return "late";
  return "starting";
}

/** One row of public.attendance_board, as the screen uses it. */
export interface BoardRow {
  assignmentId: string;
  shiftDate: string;
  startsAt: string;
  endsAt: string;
  siteId: string;
  siteName: string;
  postId: string;
  postName: string;
  workerId: string;
  workerName: string;
  staffId: string | null;
  /** In full only for roles that read it on the people record; null otherwise. */
  phone: string | null;
  phoneLast4: string | null;
  published: boolean;
  firstInAt: string | null;
  lastPunchKind: PunchKind | null;
  lastPunchAt: string | null;
  flags: PunchFlag[];
  bySupervisor: boolean;
  status: AttendanceStatus;
  /** Minutes late so far (no clock-in yet), or how late the clock-in was; null when on time. */
  lateMinutes: number | null;
  siteLastSyncAt: string | null;
  siteLateSyncs: number;
}

export interface Board {
  /** The server's clock when the board was worked out (ISO). */
  at: string;
  timeZone: string;
  lateGraceMinutes: number;
  noShowAfterMinutes: number;
  rows: BoardRow[];
}

export function emptyBoard(at: string, timeZone = "Africa/Lagos"): Board {
  return {
    at,
    timeZone,
    lateGraceMinutes: LATE_GRACE.default,
    noShowAfterMinutes: NO_SHOW_AFTER.default,
    rows: [],
  };
}

/** Flags in the punches' own order, unknown ones dropped. */
export function orderedFlags(flags: readonly string[]): PunchFlag[] {
  const set = new Set(flags);
  return PUNCH_FLAGS.filter((f) => set.has(f));
}

export function isAttendanceStatus(value: unknown): value is AttendanceStatus {
  return typeof value === "string" && (ATTENDANCE_STATUSES as readonly string[]).includes(value);
}

export type StatusCounts = Record<AttendanceStatus, number>;

export function statusCounts(rows: readonly BoardRow[]): StatusCounts {
  const counts = Object.fromEntries(ATTENDANCE_STATUSES.map((s) => [s, 0])) as StatusCounts;
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

/** Rostered right now: the shift has started and not ended. */
export function onShiftNow(row: BoardRow, now: number): boolean {
  return Date.parse(row.startsAt) <= now && now < Date.parse(row.endsAt);
}

/** The tile to open first: what needs action, else who is on site. */
export function defaultTile(counts: StatusCounts): AttendanceStatus {
  const order: AttendanceStatus[] = ["no_show", "late", "on_site", "starting", "clocked_out"];
  return order.find((s) => counts[s] > 0) ?? "on_site";
}

export interface BoardFilter {
  status: AttendanceStatus | "all";
  siteId: string | "all";
  /** Matches the worker's name or staff ID, or the post. */
  search: string;
}

export function filterRows(rows: readonly BoardRow[], filter: BoardFilter): BoardRow[] {
  const q = filter.search.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (filter.status === "all" || row.status === filter.status) &&
      (filter.siteId === "all" || row.siteId === filter.siteId) &&
      (q === "" ||
        row.workerName.toLowerCase().includes(q) ||
        (row.staffId ?? "").toLowerCase().includes(q) ||
        row.postName.toLowerCase().includes(q)),
  );
}

export interface SiteSummary {
  siteId: string;
  siteName: string;
  /** Rostered now (shift started, not ended). */
  rosteredNow: number;
  onSite: number;
  late: number;
  noShow: number;
  lastSyncAt: string | null;
  lateSyncs: number;
}

/** The By site view, from the same rows: no second query. Most no-shows and late first. */
export function siteSummaries(rows: readonly BoardRow[], now: number): SiteSummary[] {
  const map = new Map<string, SiteSummary>();
  for (const row of rows) {
    let site = map.get(row.siteId);
    if (!site) {
      site = {
        siteId: row.siteId,
        siteName: row.siteName,
        rosteredNow: 0,
        onSite: 0,
        late: 0,
        noShow: 0,
        lastSyncAt: row.siteLastSyncAt,
        lateSyncs: row.siteLateSyncs,
      };
      map.set(row.siteId, site);
    }
    if (onShiftNow(row, now)) site.rosteredNow += 1;
    if (row.status === "on_site") site.onSite += 1;
    if (row.status === "late") site.late += 1;
    if (row.status === "no_show") site.noShow += 1;
  }
  return [...map.values()].sort(
    (a, b) =>
      b.noShow - a.noShow || b.late - a.late || a.siteName.localeCompare(b.siteName, "en-GB"),
  );
}

/** The sites on the board, by name, for the site filter. */
export function boardSites(rows: readonly BoardRow[]): { id: string; name: string }[] {
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.siteId, row.siteName);
  return [...map.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "en-GB"));
}

/** "Just now", "4 min ago", "2 h ago", or "No punches today". */
export function formatSince(at: string | null, now: number): string {
  if (!at) return "No punches today";
  const minutes = Math.floor((now - Date.parse(at)) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

/** "Late 22 min", "Starts 11:00", "On site · 14 min late", "No-show", "Clocked out 18:04". */
export function statusText(row: BoardRow, timeZone: string, now: number): string {
  switch (row.status) {
    case "late":
      return `Late ${row.lateMinutes ?? 0} min`;
    case "no_show":
      return "No-show";
    case "starting":
      return Date.parse(row.startsAt) > now
        ? `Starts ${timeIn(row.startsAt, timeZone)}`
        : `Due ${timeIn(row.startsAt, timeZone)}`;
    case "on_site":
      return row.lateMinutes !== null ? `On site · ${row.lateMinutes} min late` : "On site";
    case "clocked_out":
      return row.lastPunchAt ? `Clocked out ${timeIn(row.lastPunchAt, timeZone)}` : "Clocked out";
  }
}

/** Status tone (DESIGN_SYSTEM: a word plus a dot; signal only when it needs action). */
export function statusTone(status: AttendanceStatus): "done" | "pending" | "partial" | "action" {
  switch (status) {
    case "late":
    case "no_show":
      return "action";
    case "on_site":
      return "done";
    case "clocked_out":
      return "partial";
    case "starting":
      return "pending";
  }
}

/** "06:52 · clock-in", "18:04 · clock-out", or "None". */
export function lastPunchText(row: BoardRow, timeZone: string): string {
  if (!row.lastPunchAt || !row.lastPunchKind) return "None";
  return `${timeIn(row.lastPunchAt, timeZone)} · ${row.lastPunchKind === "in" ? "clock-in" : "clock-out"}`;
}

export function shiftText(row: BoardRow, timeZone: string): string {
  return formatShiftHours(row.startsAt, row.endsAt, timeZone);
}

/** Flag words for the list, plus "By supervisor" (3.6) and "Not published". */
export function flagLabels(row: BoardRow): string[] {
  const labels = row.flags.filter((f) => f !== "late").map((f) => PUNCH_FLAG_LABELS[f]);
  if (row.bySupervisor) labels.push("By supervisor");
  if (!row.published) labels.push("Not published");
  return labels;
}

/** Late or no-show: the rows that get Call and Send replacement. */
export function needsAction(row: BoardRow): boolean {
  return row.status === "late" || row.status === "no_show";
}

/**
 * What the Call column shows. A `tel:` link only when the number came back in full (roles that
 * read it on the people record); otherwise the masked number, and nothing to dial.
 */
export function callTarget(row: BoardRow): { href: string; label: string } | { masked: string } | null {
  if (row.phone) {
    const digits = row.phone.replace(/\D/g, "");
    if (digits.length >= 7) return { href: `tel:${digits}`, label: maskPhone(row.phone) };
  }
  if (row.phoneLast4) return { masked: maskPhone(row.phoneLast4) };
  return null;
}

/** Where Send replacement goes: the roster's week for the site, opened on that post-day. */
export function replacementHref(row: BoardRow, weekStart: string): string {
  const params = new URLSearchParams({
    site: row.siteId,
    week: weekStart,
    post: row.postId,
    date: row.shiftDate,
    replace: row.assignmentId,
  });
  return `/app/roster?${params.toString()}`;
}

/** "118 on shift now" / "1 on shift now". */
export function headline(rows: readonly BoardRow[], now: number): string {
  const n = rows.filter((r) => onShiftNow(r, now)).length;
  return `${n} on shift now`;
}

/** "5 sites · 3 punches sent late today". */
export function subline(rows: readonly BoardRow[]): string {
  const sites = siteSummariesCount(rows);
  const lateSyncs = [...new Map(rows.map((r) => [r.siteId, r.siteLateSyncs])).values()].reduce(
    (a, b) => a + b,
    0,
  );
  const parts = [`${sites} ${sites === 1 ? "site" : "sites"}`];
  if (lateSyncs > 0) {
    parts.push(`${lateSyncs} ${lateSyncs === 1 ? "punch" : "punches"} sent late today`);
  }
  return parts.join(" · ");
}

function siteSummariesCount(rows: readonly BoardRow[]): number {
  return new Set(rows.map((r) => r.siteId)).size;
}
