import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { todayIn } from "@/lib/dates";
import {
  dayBoundsIn,
  summarisePatrolDay,
  type PatrolCheckpoint,
  type PatrolDay,
  type PatrolScan,
} from "@/lib/patrols";
import type { ManagerRole } from "@/lib/roles";
import { loadVisibleWorkerNames } from "@/server/people/team";
import type { Database } from "@/types/db";

/**
 * Reads for the patrol history (slice 3.8), all with the manager's own session, so RLS decides
 * what they see: owner, admin, hr and ops_manager read every scan in the company, a line manager
 * their reportees' scans only. Scans are punches of kind `checkpoint`; the point is never read.
 *
 * - `loadPatrolSites`: the sites that have checkpoints, for the site picker.
 * - `loadPatrolDay`: one site's day: checkpoints in round order, each with its scans (when, who,
 *   inside or outside, distance), and the active checkpoints nobody scanned.
 * - `loadPatrolSummary`: today's scans per site, counts only, for Lira.
 */

type Client = SupabaseClient<Database>;

/** Who opens the patrol history: the Live attendance page's roles, hr included (punch readers). */
export const PATROL_READERS: readonly ManagerRole[] = [
  "owner",
  "admin",
  "hr",
  "ops_manager",
  "line_manager",
];

export interface PatrolSite {
  id: string;
  name: string;
  archived: boolean;
  checkpoints: number;
}

async function orgTimeZone(supabase: Client, organisationId: string): Promise<string> {
  const { data, error } = await supabase
    .from("organisations")
    .select("timezone")
    .eq("id", organisationId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the company (${error.code})`);
  return data?.timezone ?? "Africa/Lagos";
}

export async function loadPatrolSettings(
  supabase: Client,
  organisationId: string,
  now: Date = new Date(),
): Promise<{ timeZone: string; today: string }> {
  const timeZone = await orgTimeZone(supabase, organisationId);
  return { timeZone, today: todayIn(timeZone, now) };
}

/** Sites with at least one active checkpoint, active sites first, by name. */
export async function loadPatrolSites(
  supabase: Client,
  organisationId: string,
): Promise<PatrolSite[]> {
  const { data: points, error } = await supabase
    .from("site_checkpoints")
    .select("site_id")
    .eq("organisation_id", organisationId)
    .eq("status", "active")
    .limit(5000);
  if (error) throw new Error(`Could not read checkpoints (${error.code})`);
  const counts = new Map<string, number>();
  for (const p of points ?? []) counts.set(p.site_id, (counts.get(p.site_id) ?? 0) + 1);
  if (counts.size === 0) return [];
  const { data: sites, error: siteError } = await supabase
    .from("sites")
    .select("id, name, status")
    .eq("organisation_id", organisationId)
    .in("id", [...counts.keys()]);
  if (siteError) throw new Error(`Could not read sites (${siteError.code})`);
  return (sites ?? [])
    .map((s) => ({
      id: s.id,
      name: s.name,
      archived: s.status === "archived",
      checkpoints: counts.get(s.id) ?? 0,
    }))
    .sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name));
}

const geofence = z.enum(["inside", "near", "outside", "unknown"]);

function fullName(w: { first_name: string; last_name: string } | undefined): string {
  return w ? `${w.first_name} ${w.last_name}`.trim() : "A worker";
}

/**
 * Scanners' names. A line manager reads their reportees through my_reportees (slice 4.0); the
 * other roles read public.workers.
 */
async function workerNames(
  supabase: Client,
  organisationId: string,
  ids: string[],
): Promise<Map<string, string>> {
  const names = await loadVisibleWorkerNames(supabase, organisationId, ids);
  return new Map(
    [...names].map(([id, w]) => [id, fullName({ first_name: w.firstName, last_name: w.lastName })]),
  );
}

/** One site's patrol day in the company's time zone. */
export async function loadPatrolDay(
  supabase: Client,
  organisationId: string,
  siteId: string,
  day: string,
  timeZone: string,
): Promise<PatrolDay> {
  const { start, end } = dayBoundsIn(day, timeZone);
  const [checkpointsRead, scansRead] = await Promise.all([
    supabase
      .from("site_checkpoints")
      .select("id, name, sort_order, status")
      .eq("organisation_id", organisationId)
      .eq("site_id", siteId),
    supabase
      .from("punches")
      .select("id, checkpoint_id, worker_id, recorded_at, geofence_result, distance_m, flags")
      .eq("organisation_id", organisationId)
      .eq("site_id", siteId)
      .eq("kind", "checkpoint")
      .gte("recorded_at", start.toISOString())
      .lt("recorded_at", end.toISOString())
      .order("recorded_at")
      .limit(2000),
  ]);
  if (checkpointsRead.error) {
    throw new Error(`Could not read checkpoints (${checkpointsRead.error.code})`);
  }
  if (scansRead.error) throw new Error(`Could not read scans (${scansRead.error.code})`);

  const checkpoints: PatrolCheckpoint[] = (checkpointsRead.data ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    sortOrder: c.sort_order,
    status: c.status === "retired" ? "retired" : "active",
  }));
  const rows = (scansRead.data ?? []).filter((r) => r.checkpoint_id !== null);
  const names = await workerNames(supabase, organisationId, [
    ...new Set(rows.map((r) => r.worker_id)),
  ]);
  const scans: PatrolScan[] = rows.map((r) => ({
    id: r.id,
    checkpointId: r.checkpoint_id as string,
    workerId: r.worker_id,
    workerName: names.get(r.worker_id) ?? "A worker",
    recordedAt: r.recorded_at,
    geofence: geofence.catch("unknown").parse(r.geofence_result),
    distanceM: r.distance_m,
    flags: r.flags,
  }));
  return summarisePatrolDay(checkpoints, scans);
}

export interface PatrolSummary {
  day: string;
  totalScans: number;
  /** Scans outside or near the site, or with no location. */
  flaggedScans: number;
  sites: {
    siteId: string;
    siteName: string;
    scans: number;
    checkpointsScanned: number;
    checkpointsActive: number;
  }[];
}

/** Today's scans per site, counts only (no names, no places), for Lira. */
export async function loadPatrolSummary(
  supabase: Client,
  organisationId: string,
  now: Date = new Date(),
): Promise<PatrolSummary> {
  const { timeZone, today } = await loadPatrolSettings(supabase, organisationId, now);
  const sites = await loadPatrolSites(supabase, organisationId);
  const days = await Promise.all(
    sites
      .filter((s) => !s.archived)
      .slice(0, 50)
      .map(async (s) => ({
        site: s,
        day: await loadPatrolDay(supabase, organisationId, s.id, today, timeZone),
      })),
  );
  return {
    day: today,
    totalScans: days.reduce((n, d) => n + d.day.totalScans, 0),
    flaggedScans: days.reduce((n, d) => n + d.day.flaggedScans, 0),
    sites: days.map(({ site, day }) => ({
      siteId: site.id,
      siteName: site.name,
      scans: day.totalScans,
      checkpointsScanned: day.scannedCount,
      checkpointsActive: day.activeCount,
    })),
  };
}
