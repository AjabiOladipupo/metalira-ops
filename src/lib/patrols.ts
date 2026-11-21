/**
 * The patrol history (slice 3.8): per site per day, which checkpoints were scanned, when and by
 * whom. Pure, so the grouping is unit tested; src/server/workforce/patrol-data.ts reads the rows.
 *
 * Phase 2 defines a site's checkpoints and their order (`sort_order`, the round) but no expected
 * rounds per shift, so nothing here is "missed": a checkpoint with no scan that day is listed as
 * "not scanned", which is a fact, not a judgement.
 */

export interface PatrolCheckpoint {
  id: string;
  name: string;
  sortOrder: number;
  status: "active" | "retired";
}

export interface PatrolScan {
  id: string;
  checkpointId: string;
  workerId: string;
  workerName: string;
  recordedAt: string;
  geofence: "inside" | "near" | "outside" | "unknown";
  distanceM: number | null;
  flags: string[];
}

export interface PatrolRow {
  checkpoint: PatrolCheckpoint;
  /** That day's scans of the checkpoint, earliest first. */
  scans: PatrolScan[];
}

export interface PatrolDay {
  /** Every active checkpoint, plus retired ones scanned that day, in round order. */
  rows: PatrolRow[];
  totalScans: number;
  /** Active checkpoints with at least one scan. */
  scannedCount: number;
  activeCount: number;
  /** Active checkpoints with no scan that day, in round order. */
  notScanned: PatrolCheckpoint[];
  /** Scans flagged outside or near the site, or with no location. */
  flaggedScans: number;
  /** Everyone who scanned, by name, with their count, most first. */
  scanners: { workerId: string; name: string; scans: number }[];
  firstScanAt: string | null;
  lastScanAt: string | null;
}

const REVIEW_FLAGS = new Set(["outside", "near", "no_location"]);

/** Whether a scan needs a look: away from the site or without a location. */
export function scanNeedsReview(scan: Pick<PatrolScan, "flags">): boolean {
  return scan.flags.some((flag) => REVIEW_FLAGS.has(flag));
}

export function summarisePatrolDay(
  checkpoints: readonly PatrolCheckpoint[],
  scans: readonly PatrolScan[],
): PatrolDay {
  const byCheckpoint = new Map<string, PatrolScan[]>();
  for (const scan of scans) {
    const list = byCheckpoint.get(scan.checkpointId) ?? [];
    list.push(scan);
    byCheckpoint.set(scan.checkpointId, list);
  }
  const ordered = [...checkpoints].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  const rows: PatrolRow[] = [];
  const notScanned: PatrolCheckpoint[] = [];
  let scannedCount = 0;
  let activeCount = 0;
  for (const checkpoint of ordered) {
    const list = (byCheckpoint.get(checkpoint.id) ?? []).sort(
      (a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || a.id.localeCompare(b.id),
    );
    if (checkpoint.status === "active") {
      activeCount += 1;
      if (list.length > 0) scannedCount += 1;
      else notScanned.push(checkpoint);
    }
    if (checkpoint.status === "active" || list.length > 0) rows.push({ checkpoint, scans: list });
  }

  const counted = scans.filter((scan) => ordered.some((c) => c.id === scan.checkpointId));
  const scanners = new Map<string, { workerId: string; name: string; scans: number }>();
  for (const scan of counted) {
    const entry = scanners.get(scan.workerId) ?? {
      workerId: scan.workerId,
      name: scan.workerName,
      scans: 0,
    };
    entry.scans += 1;
    scanners.set(scan.workerId, entry);
  }
  const times = counted.map((scan) => scan.recordedAt).sort((a, b) => Date.parse(a) - Date.parse(b));

  return {
    rows,
    totalScans: counted.length,
    scannedCount,
    activeCount,
    notScanned,
    flaggedScans: counted.filter(scanNeedsReview).length,
    scanners: [...scanners.values()].sort((a, b) => b.scans - a.scans || a.name.localeCompare(b.name)),
    firstScanAt: times[0] ?? null,
    lastScanAt: times.at(-1) ?? null,
  };
}

/** "6 of 8 checkpoints scanned · 14 scans". */
export function formatPatrolTotals(day: Pick<PatrolDay, "scannedCount" | "activeCount" | "totalScans">): string {
  const scans = `${day.totalScans} ${day.totalScans === 1 ? "scan" : "scans"}`;
  if (day.activeCount === 0) return scans;
  const word = day.activeCount === 1 ? "checkpoint" : "checkpoints";
  return `${day.scannedCount} of ${day.activeCount} ${word} scanned · ${scans}`;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The day in a `?day=` parameter: a real date no later than today, else today. */
export function parseDayParam(value: string | undefined, today: string): string {
  if (!value || !DAY.test(value)) return today;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return today;
  return value > today ? today : value;
}

/** The zone's offset from UTC at `at`, in ms (Lagos: +1 h). */
function zoneOffsetMs(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - at.getTime();
}

/** The start and end (exclusive) of `day` in `timeZone`, as instants. */
export function dayBoundsIn(day: string, timeZone: string): { start: Date; end: Date } {
  const noon = new Date(`${day}T12:00:00Z`);
  const offset = zoneOffsetMs(timeZone, noon);
  const start = new Date(Date.parse(`${day}T00:00:00Z`) - offset);
  return { start, end: new Date(start.getTime() + 24 * 3_600_000) };
}
