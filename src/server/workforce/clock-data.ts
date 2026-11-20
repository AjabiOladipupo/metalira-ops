import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { todayIn } from "@/lib/dates";
import { pointsFromGeoJson } from "@/lib/geofence";
import type { ClockSite } from "@/lib/punches/clock";
import { OPEN_PUNCH_HOURS, PUNCH_FLAGS, type PunchFlag } from "@/lib/punches/flags";
import type { ManagerRole } from "@/lib/roles";
import type { Database } from "@/types/db";

/**
 * Reads for clock-in (slice 3.5).
 *
 * - `loadClockContext`: what the worker's clock screen and home need, from
 *   public.my_clock_context with the worker's own session (their consents, last punch, shifts
 *   from 20 hours ago to 24 hours ahead with the post's name, and the sites they can clock in at
 *   with each geofence, for the screen's distance preview).
 * - `loadTodayPunchSummary`: today's punches in the company counted by kind and by flag, for
 *   managers and Lira (`attendance.today_summary`). Counts only, no names and no places; read
 *   under RLS, so a line manager counts their reportees only.
 */

type Client = SupabaseClient<Database>;

const contextSchema = z.object({
  worker_id: z.uuid(),
  worker_status: z.string(),
  shifts_enabled: z.boolean(),
  late_grace_minutes: z.number().int().nullable(),
  location_consent: z.boolean(),
  selfie_consent: z.boolean(),
  last_punch: z
    .object({
      kind: z.enum(["in", "out"]),
      recorded_at: z.string(),
      site_id: z.uuid().nullable(),
    })
    .nullable(),
  assignments: z.array(
    z.object({
      id: z.uuid(),
      shift_id: z.uuid(),
      site_id: z.uuid(),
      starts_at: z.string(),
      ends_at: z.string(),
      post_name: z.string(),
    }),
  ),
  sites: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      centre_lat: z.number().nullable(),
      centre_lng: z.number().nullable(),
      radius_m: z.number(),
      boundary: z.unknown().nullable(),
      has_geofence: z.boolean(),
    }),
  ),
});

export interface ClockShift {
  assignmentId: string;
  siteId: string;
  siteName: string;
  postName: string;
  startsAt: string;
  endsAt: string;
}

export interface ClockContext {
  workerId: string;
  left: boolean;
  shiftsEnabled: boolean;
  locationConsent: boolean;
  selfieConsent: boolean;
  lastPunch: {
    kind: "in" | "out";
    recordedAt: string;
    siteId: string | null;
    /** A clock-in from the last 20 hours: the worker is clocked in. */
    open: boolean;
  } | null;
  /** Assigned shifts from 20 hours ago to 24 hours ahead, earliest first. */
  shifts: ClockShift[];
  sites: ClockSite[];
}

/** The shift a punch now would belong to (window: 2 h before the start to 4 h after the end). */
export function currentShift(shifts: readonly ClockShift[], now: number): ClockShift | null {
  let best: ClockShift | null = null;
  let bestGap = Infinity;
  for (const shift of shifts) {
    const start = Date.parse(shift.startsAt);
    const end = Date.parse(shift.endsAt);
    if (now < start - 2 * 3_600_000 || now > end + 4 * 3_600_000) continue;
    const gap = Math.abs(now - start);
    if (gap < bestGap) {
      best = shift;
      bestGap = gap;
    }
  }
  return best;
}

export async function loadClockContext(
  supabase: Client,
  organisationId: string,
  now: Date = new Date(),
): Promise<ClockContext> {
  const { data, error } = await supabase.rpc("my_clock_context", {
    p_organisation_id: organisationId,
  });
  if (error) throw new Error(`Could not load the clock (${error.code})`);
  const ctx = contextSchema.parse(data);
  const names = new Map(ctx.sites.map((site) => [site.id, site.name]));
  return {
    workerId: ctx.worker_id,
    left: ctx.worker_status === "ended",
    shiftsEnabled: ctx.shifts_enabled,
    locationConsent: ctx.location_consent,
    selfieConsent: ctx.selfie_consent,
    lastPunch: ctx.last_punch
      ? {
          kind: ctx.last_punch.kind,
          recordedAt: ctx.last_punch.recorded_at,
          siteId: ctx.last_punch.site_id,
          open:
            ctx.last_punch.kind === "in" &&
            now.getTime() - Date.parse(ctx.last_punch.recorded_at) < OPEN_PUNCH_HOURS * 3_600_000,
        }
      : null,
    shifts: ctx.assignments.map((a) => ({
      assignmentId: a.id,
      siteId: a.site_id,
      siteName: names.get(a.site_id) ?? "Your site",
      postName: a.post_name,
      startsAt: a.starts_at,
      endsAt: a.ends_at,
    })),
    sites: ctx.sites.map((site) => ({
      id: site.id,
      name: site.name,
      centre:
        site.centre_lat !== null && site.centre_lng !== null
          ? { lat: site.centre_lat, lng: site.centre_lng }
          : null,
      radiusM: site.radius_m,
      boundary: site.boundary ? pointsFromGeoJson(site.boundary) : null,
      hasGeofence: site.has_geofence,
    })),
  };
}

export const PUNCH_SUMMARY_READERS: readonly ManagerRole[] = [
  "owner",
  "admin",
  "ops_manager",
  "hr",
  "line_manager",
];

export interface TodayPunchSummary {
  /** The company's day, "2026-11-20". */
  day: string;
  clockIns: number;
  clockOuts: number;
  /** Workers with at least one punch today. */
  workers: number;
  byFlag: Record<PunchFlag, number>;
}

/** Today's punches (company time zone), counted. */
export async function loadTodayPunchSummary(
  supabase: Client,
  organisationId: string,
  now: Date = new Date(),
): Promise<TodayPunchSummary> {
  const { data: org, error: orgError } = await supabase
    .from("organisations")
    .select("timezone")
    .eq("id", organisationId)
    .maybeSingle();
  if (orgError) throw new Error(`Could not read the company (${orgError.code})`);
  const zone = org?.timezone ?? "Africa/Lagos";
  const day = todayIn(zone, now);
  // The day's start in the company's zone: noon UTC that day minus the zone's offset at noon.
  const noon = new Date(`${day}T12:00:00Z`);
  const offsetMs = zoneOffsetMs(zone, noon);
  const start = new Date(Date.parse(`${day}T00:00:00Z`) - offsetMs);
  const end = new Date(start.getTime() + 24 * 3_600_000);

  const byFlag = Object.fromEntries(PUNCH_FLAGS.map((f) => [f, 0])) as Record<PunchFlag, number>;
  const workers = new Set<string>();
  let clockIns = 0;
  let clockOuts = 0;
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("punches")
      .select("worker_id, kind, flags")
      .eq("organisation_id", organisationId)
      .gte("recorded_at", start.toISOString())
      .lt("recorded_at", end.toISOString())
      .order("recorded_at")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Could not count punches (${error.code})`);
    for (const row of data ?? []) {
      workers.add(row.worker_id);
      if (row.kind === "in") clockIns += 1;
      else clockOuts += 1;
      for (const flag of row.flags) {
        if (flag in byFlag) byFlag[flag as PunchFlag] += 1;
      }
    }
    if ((data ?? []).length < PAGE) break;
  }
  return { day, clockIns, clockOuts, workers: workers.size, byFlag };
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
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - at.getTime();
}
