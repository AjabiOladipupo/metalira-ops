import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { todayIn } from "@/lib/dates";
import { pointsFromGeoJson } from "@/lib/geofence";
import type { ClockSite } from "@/lib/punches/clock";
import type { CrewMember } from "@/lib/punches/crew";
import type { ManagerRole } from "@/lib/roles";
import type { Database } from "@/types/db";

/**
 * Reads for crew clock-in (slice 3.6).
 *
 * - `loadCrewContext`: what the crew screen needs, from public.my_crew_context with the
 *   supervisor's own session: the queue owner (actor), Shifts, their location consent, the size
 *   of their crew, and the sites where they can clock in a crew now with the crew on shift there.
 * - `loadTodayCrewSummary`: today's crew punches in the company, counted (batches, people, how
 *   many without a group photo, outside), for managers and Lira (`attendance.crew_summary`).
 *   Counts only; read under RLS.
 */

type Client = SupabaseClient<Database>;

const memberSchema = z.object({
  worker_id: z.uuid(),
  first_name: z.string(),
  last_name: z.string(),
  staff_id: z.string(),
  no_phone: z.boolean(),
  starts_at: z.string(),
  ends_at: z.string(),
  post_name: z.string(),
  selfie_consent: z.boolean(),
  last_kind: z.enum(["in", "out"]).nullable(),
  last_at: z.string().nullable(),
  last_by_supervisor: z.boolean().nullable(),
});

const contextSchema = z.object({
  actor_kind: z.enum(["worker", "line_manager"]),
  actor_id: z.uuid(),
  supervisor_status: z.string().nullable(),
  shifts_enabled: z.boolean(),
  location_consent: z.boolean(),
  crew_size: z.number().int(),
  sites: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      centre_lat: z.number().nullable(),
      centre_lng: z.number().nullable(),
      radius_m: z.number(),
      boundary: z.unknown().nullable(),
      has_geofence: z.boolean(),
      shift: z
        .object({ starts_at: z.string(), ends_at: z.string(), post_name: z.string() })
        .nullable(),
      crew: z.array(memberSchema),
    }),
  ),
});

export interface CrewSite extends ClockSite {
  /** The supervisor's own shift here, when they have a worker record. */
  shift: { startsAt: string; endsAt: string; postName: string } | null;
  crew: CrewMember[];
}

export interface CrewContext {
  actorKind: "worker" | "line_manager";
  actorId: string;
  left: boolean;
  shiftsEnabled: boolean;
  locationConsent: boolean;
  /** Everyone the caller supervises, on shift or not. Zero: not a supervisor. */
  crewSize: number;
  sites: CrewSite[];
}

export async function loadCrewContext(supabase: Client, organisationId: string): Promise<CrewContext> {
  const { data, error } = await supabase.rpc("my_crew_context", {
    p_organisation_id: organisationId,
  });
  if (error) throw new Error(`Could not load the crew (${error.code})`);
  const ctx = contextSchema.parse(data);
  return {
    actorKind: ctx.actor_kind,
    actorId: ctx.actor_id,
    left: ctx.supervisor_status === "ended",
    shiftsEnabled: ctx.shifts_enabled,
    locationConsent: ctx.location_consent,
    crewSize: ctx.crew_size,
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
      shift: site.shift
        ? {
            startsAt: site.shift.starts_at,
            endsAt: site.shift.ends_at,
            postName: site.shift.post_name,
          }
        : null,
      crew: site.crew.map((m) => ({
        workerId: m.worker_id,
        firstName: m.first_name,
        lastName: m.last_name,
        staffId: m.staff_id,
        noPhone: m.no_phone,
        startsAt: m.starts_at,
        endsAt: m.ends_at,
        postName: m.post_name,
        selfieConsent: m.selfie_consent,
        lastKind: m.last_kind,
        lastAt: m.last_at,
        lastBySupervisor: m.last_by_supervisor === true,
      })),
    })),
  };
}

/** Whether the signed-in worker supervises anyone (the home card). Never throws. */
export async function hasCrew(supabase: Client, organisationId: string): Promise<boolean> {
  try {
    return (await loadCrewContext(supabase, organisationId)).crewSize > 0;
  } catch {
    return false;
  }
}

export const CREW_SUMMARY_READERS: readonly ManagerRole[] = ["owner", "admin", "ops_manager", "hr"];

export interface TodayCrewSummary {
  /** The company's day, "2026-11-20". */
  day: string;
  /** Crew clock-ins and clock-outs sent by supervisors today. */
  batches: number;
  clockIns: number;
  clockOuts: number;
  /** Crew clock-ins with no group photo (flagged for review). */
  withoutPhoto: number;
  /** Batches sent from outside or near the site, by the supervisor's phone. */
  awayFromSite: number;
}

/** Today's crew punches (by the server's received day in the company's zone), counted. */
export async function loadTodayCrewSummary(
  supabase: Client,
  organisationId: string,
  now: Date = new Date(),
): Promise<TodayCrewSummary> {
  const { data: org, error: orgError } = await supabase
    .from("organisations")
    .select("timezone")
    .eq("id", organisationId)
    .maybeSingle();
  if (orgError) throw new Error(`Could not read the company (${orgError.code})`);
  const day = todayIn(org?.timezone ?? "Africa/Lagos", now);
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const { data, error } = await supabase
    .from("crew_punch_batches")
    .select("kind, worker_count, photo_expected, geofence_result, recorded_at")
    .eq("organisation_id", organisationId)
    .gte("recorded_at", since)
    .limit(2000);
  if (error) throw new Error(`Could not count crew punches (${error.code})`);
  const zone = org?.timezone ?? "Africa/Lagos";
  const rows = (data ?? []).filter((row) => todayIn(zone, new Date(row.recorded_at)) === day);
  let clockIns = 0;
  let clockOuts = 0;
  let withoutPhoto = 0;
  let awayFromSite = 0;
  for (const row of rows) {
    if (row.kind === "in") {
      clockIns += row.worker_count;
      if (!row.photo_expected) withoutPhoto += row.worker_count;
    } else {
      clockOuts += row.worker_count;
    }
    if (row.geofence_result === "outside" || row.geofence_result === "near") awayFromSite += 1;
  }
  return { day, batches: rows.length, clockIns, clockOuts, withoutPhoto, awayFromSite };
}
