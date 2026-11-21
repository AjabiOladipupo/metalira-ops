import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import { Illustration } from "@/components/illustration";
import { KpiTile } from "@/components/kpi-tile";
import { PageHeader } from "@/components/page-header";
import { StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { NO_ACCESS_PATH } from "@/lib/auth/routes";
import { addDays, formatDate } from "@/lib/dates";
import {
  formatPatrolTotals,
  parseDayParam,
  scanMarkers,
  scanNeedsReview,
  type PatrolScan,
} from "@/lib/patrols";
import { formatDistance } from "@/lib/punches/clock";
import { timeIn } from "@/lib/roster";
import { createServerSupabase } from "@/lib/supabase/server";
import { getPageSession } from "@/server/identity/session";
import { loadPatrolDay, loadPatrolSettings, loadPatrolSites } from "@/server/workforce/patrol-data";

import { RouteGate } from "../../_shell/slots";

export const metadata: Metadata = { title: "Patrols" };

const HREF = "/app/attendance/patrols";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function patrolHref(siteId: string, day: string): string {
  return `${HREF}?site=${siteId}&day=${day}`;
}

function scanWhere(scan: PatrolScan): string {
  switch (scan.geofence) {
    case "inside":
      return "Inside the site";
    case "near":
      return "Near the site";
    case "outside":
      return scan.distanceM !== null
        ? `Outside the site, ${formatDistance(scan.distanceM)} away`
        : "Outside the site";
    default:
      return scan.flags.includes("no_location") ? "No location" : "Not checked";
  }
}

async function PatrolsPage({
  searchParams,
}: {
  searchParams: PageProps<"/app/attendance/patrols">["searchParams"];
}) {
  const query = await searchParams;
  const session = await getPageSession();
  if (!session?.active) redirect(NO_ACCESS_PATH);
  const { organisationId } = session.active;
  const supabase = await createServerSupabase();
  const [{ timeZone, today }, sites] = await Promise.all([
    loadPatrolSettings(supabase, organisationId),
    loadPatrolSites(supabase, organisationId),
  ]);

  if (sites.length === 0) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader
          title="Patrols"
          description="Checkpoint scans by site and day."
          back={{ href: "/app/attendance", label: "Live attendance" }}
        />
        <EmptyState
          illustration={<Illustration name="roster-empty" size="empty" decorative />}
          message="No checkpoints yet. Add checkpoints to a site and print their QR codes for your patrol guards."
          action={
            <Button asChild variant="outline">
              <Link href="/app/clients">Open clients</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const day = parseDayParam(first(query.day), today);
  const requested = first(query.site);
  const site = sites.find((s) => s.id === requested) ?? sites[0]!;
  const patrol = await loadPatrolDay(supabase, organisationId, site.id, day, timeZone);
  const time = (at: string) => timeIn(at, timeZone);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow={site.name}
        title={day === today ? "Patrols today" : `Patrols on ${formatDate(day)}`}
        description={formatPatrolTotals(patrol)}
        back={{ href: "/app/attendance", label: "Live attendance" }}
      />

      <form
        method="get"
        action={HREF}
        className="flex flex-wrap items-end gap-2"
        data-testid="patrol-filters"
      >
        <label className="flex max-w-full min-w-0 flex-col gap-1 text-sm">
          <span className="text-fg-muted">Site</span>
          <select
            name="site"
            defaultValue={site.id}
            className="h-10 max-w-full min-w-0 rounded-lg border border-line bg-background px-3 text-sm font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
          >
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.archived ? " (archived)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-fg-muted">Day</span>
          <input
            type="date"
            name="day"
            defaultValue={day}
            max={today}
            className="h-10 rounded-lg border border-line bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
          />
        </label>
        <Button type="submit" variant="outline">
          Show
        </Button>
        <nav aria-label="Days" className="flex items-center gap-1">
          <Button asChild variant="outline" size="icon">
            <Link href={patrolHref(site.id, addDays(day, -1))} aria-label="Previous day">
              <span aria-hidden>‹</span>
            </Link>
          </Button>
          {day < today ? (
            <Button asChild variant="outline" size="icon">
              <Link href={patrolHref(site.id, addDays(day, 1))} aria-label="Next day">
                <span aria-hidden>›</span>
              </Link>
            </Button>
          ) : null}
        </nav>
      </form>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="patrol-tiles">
        <KpiTile
          label="Scanned"
          value={`${patrol.scannedCount} of ${patrol.activeCount}`}
          variant="filled"
        />
        <KpiTile label="Scans" value={String(patrol.totalScans)} variant="filled" />
        <KpiTile label="Not scanned" value={String(patrol.notScanned.length)} />
        <KpiTile
          label="To check"
          value={String(patrol.flaggedScans)}
          note="Away, late or unverified"
        />
      </div>

      {patrol.scanners.length > 0 ? (
        <p className="m-0 text-sm text-fg-muted" data-testid="patrol-scanners">
          {patrol.scanners.map((s) => `${s.name} (${s.scans})`).join(" · ")}
          {patrol.firstScanAt && patrol.lastScanAt
            ? ` · ${time(patrol.firstScanAt)} to ${time(patrol.lastScanAt)}`
            : ""}
        </p>
      ) : null}

      <ol className="m-0 flex list-none flex-col gap-3 p-0" data-testid="patrol-list">
        {patrol.rows.map(({ checkpoint, scans }) => (
          <li
            key={checkpoint.id}
            className="flex flex-col gap-2 rounded-xl border border-line p-4"
            data-testid="patrol-checkpoint"
            data-scans={scans.length}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold">
                {checkpoint.name}
                {checkpoint.status === "retired" ? (
                  <span className="font-normal text-fg-muted"> (retired)</span>
                ) : null}
              </span>
              <span className="flex items-center gap-2 text-sm">
                <StatusDot tone={scans.length > 0 ? "done" : "pending"} />
                {scans.length === 0
                  ? "Not scanned"
                  : `${scans.length} ${scans.length === 1 ? "scan" : "scans"}`}
              </span>
            </div>
            {scans.length > 0 ? (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {scans.map((scan) => (
                  <li
                    key={scan.id}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm"
                    data-testid="patrol-scan"
                  >
                    <span className="w-12 shrink-0 font-semibold tabular-nums">
                      {time(scan.recordedAt)}
                    </span>
                    <span className="min-w-0">{scan.workerName}</span>
                    <span className={scanNeedsReview(scan) ? "font-semibold" : "text-fg-muted"}>
                      {scanWhere(scan)}
                    </span>
                    {scanMarkers(scan.flags).map((marker) => (
                      <span
                        key={marker}
                        className="rounded-full border border-foreground px-2 text-xs font-semibold"
                        data-testid="patrol-marker"
                      >
                        {marker}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>

      {patrol.activeCount > 0 && patrol.totalScans === 0 ? (
        <p className="m-0 text-sm text-fg-muted">
          No scans at {site.name} on this day. Scans arrive as guards scan each checkpoint&apos;s QR
          code with their phone.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The patrol history (slice 3.8): per site per day, which checkpoints were scanned, when and by
 * whom, and which active checkpoints nobody scanned. Read under RLS with the manager's own
 * session (a line manager sees their reportees' scans only). Phase 2 has no expected rounds per
 * shift, so the page lists facts; it never calls a checkpoint "missed".
 */
export default function Page({ searchParams }: PageProps<"/app/attendance/patrols">) {
  return (
    <RouteGate href={HREF}>
      <PatrolsPage searchParams={searchParams} />
    </RouteGate>
  );
}
