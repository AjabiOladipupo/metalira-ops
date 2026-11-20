import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  toPublicationStatus,
  toPublishResult,
  type PublicationStatus,
  type PublishResult,
} from "@/lib/roster-publish";
import { todayIn } from "@/lib/dates";
import type { Database } from "@/types/db";

import { fromRosterDbError } from "./roster";

/**
 * Roster publishing reads (slice 3.3), with the signed-in user's own client. The database
 * functions check the role (owner, admin, ops_manager for the manager reads; the worker's own
 * records for my_published_shifts).
 */

type Client = SupabaseClient<Database>;

/** The latest version of a site's week and what changed since it. */
export async function loadPublicationStatus(
  supabase: Client,
  organisationId: string,
  siteId: string,
  weekStart: string,
): Promise<PublicationStatus> {
  const { data, error } = await supabase.rpc("roster_publication_status", {
    p_organisation_id: organisationId,
    p_site_id: siteId,
    p_week_start: weekStart,
  });
  if (error) fromRosterDbError(error);
  return toPublicationStatus(data);
}

/** "Publish roster" without publishing: the same function with its dry run (nothing written). */
export async function previewPublishRoster(
  supabase: Client,
  organisationId: string,
  siteId: string,
  weekStart: string,
): Promise<PublishResult> {
  const { data, error } = await supabase.rpc("publish_roster", {
    p_organisation_id: organisationId,
    p_site_id: siteId,
    p_week_start: weekStart,
    p_dry_run: true,
  });
  if (error) fromRosterDbError(error);
  return toPublishResult(data);
}

export interface MyShift {
  id: string;
  date: string;
  startsAt: string;
  endsAt: string;
  postName: string;
  siteName: string;
  siteAddress: string | null;
  siteLandmark: string | null;
}

/**
 * The signed-in worker's published shifts between two days (62 at most), earliest first. Only
 * their own, only what was published and is still assigned (my_published_shifts).
 */
export async function loadMyPublishedShifts(
  supabase: Client,
  from: string,
  to: string,
): Promise<MyShift[]> {
  const { data, error } = await supabase.rpc("my_published_shifts", { p_from: from, p_to: to });
  if (error) throw new Error(`Could not read your shifts (${error.code})`);
  return (data ?? []).map((r) => ({
    id: r.assignment_id,
    date: r.shift_date,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    postName: r.post_name,
    siteName: r.site_name,
    siteAddress: r.site_address,
    siteLandmark: r.site_landmark,
  }));
}

/** The company's time zone, today's date there and the moment read, for a signed-in member. */
export async function loadCompanyClock(
  supabase: Client,
  organisationId: string,
): Promise<{ timeZone: string; today: string; nowMs: number }> {
  const { data } = await supabase
    .from("organisations")
    .select("timezone")
    .eq("id", organisationId)
    .maybeSingle();
  const timeZone = data?.timezone ?? "Africa/Lagos";
  const now = new Date();
  return { timeZone, today: todayIn(timeZone, now), nowMs: now.getTime() };
}
