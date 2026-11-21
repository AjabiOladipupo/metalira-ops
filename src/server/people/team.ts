import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { EmploymentType } from "@/lib/people";
import type { ManagerRole } from "@/lib/roles";
import type { Database } from "@/types/db";

/**
 * A line manager's people (slice 4.0). Line managers no longer read `public.workers`: their
 * reportees come from `public.my_reportees`, a definer read that returns safe columns only (no
 * bank, tax, NIN, RSA, pension, NHF, rent, pay or next of kin). Anyone else gets no rows from it,
 * so the helpers here are safe to call for any role.
 */

type Client = SupabaseClient<Database>;

/** Who may read their team: line managers (anyone else simply has no reportees). */
export const TEAM_READERS = ["line_manager"] as const satisfies readonly ManagerRole[];

export type WorkerStatus = Database["public"]["Enums"]["worker_status"];

export interface TeamMember {
  id: string;
  staffId: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  jobTitle: string | null;
  departmentId: string | null;
  departmentName: string | null;
  employmentType: EmploymentType;
  status: WorkerStatus;
  startDate: string;
  endDate: string | null;
  lineManagerWorkerId: string | null;
  lineManagerMembershipId: string | null;
  lineManagerName: string | null;
  /** ISO weekdays (1 Monday to 7 Sunday), or null for the company's default week. */
  usualWorkDays: number[] | null;
  supervisorClockIn: boolean;
  siteIds: string[];
  siteNames: string[];
}

type Row = Database["public"]["Functions"]["my_reportees"]["Returns"][number];

/** The generated type says every column is set; the database may still return null. */
type Nullable<T> = { [K in keyof T]: T[K] | null };

function toMember(raw: Row): TeamMember {
  const row = raw as Nullable<Row>;
  return {
    id: raw.id,
    staffId: raw.staff_id,
    firstName: raw.first_name,
    lastName: raw.last_name,
    phone: row.phone,
    email: row.email,
    jobTitle: row.job_title,
    departmentId: row.department_id,
    departmentName: row.department_name,
    employmentType: raw.employment_type,
    status: raw.status,
    startDate: raw.start_date,
    endDate: row.end_date,
    lineManagerWorkerId: row.line_manager_worker_id,
    lineManagerMembershipId: row.line_manager_membership_id,
    lineManagerName: row.line_manager_name,
    usualWorkDays: row.usual_work_days,
    supervisorClockIn: raw.supervisor_clock_in,
    siteIds: row.site_ids ?? [],
    siteNames: row.site_names ?? [],
  };
}

/** The signed-in line manager's reportees in the company, by last then first name. */
export async function loadTeamMembers(
  supabase: Client,
  organisationId: string,
): Promise<TeamMember[]> {
  const { data, error } = await supabase.rpc("my_reportees", {
    p_organisation_id: organisationId,
  });
  if (error) throw new Error(`Could not read your team (${error.code})`);
  return (data ?? []).map(toMember);
}

/** One reportee, or null when they don't report to the signed-in user. */
export async function loadTeamMember(
  supabase: Client,
  organisationId: string,
  workerId: string,
): Promise<TeamMember | null> {
  const members = await loadTeamMembers(supabase, organisationId);
  return members.find((m) => m.id === workerId) ?? null;
}

export interface TeamSummary {
  total: number;
  byStatus: Record<WorkerStatus, number>;
  /** Active reportees who clock in through their supervisor (shared phone). */
  supervisorClockIn: number;
  /** Active reportees with no site mapped. */
  noSite: number;
}

/** Counts only: no names, phones or other personal details (for Lira and the My team tiles). */
export function summariseTeam(members: readonly TeamMember[]): TeamSummary {
  const byStatus: Record<WorkerStatus, number> = { active: 0, ended: 0 };
  for (const m of members) byStatus[m.status] += 1;
  const active = members.filter((m) => m.status === "active");
  return {
    total: members.length,
    byStatus,
    supervisorClockIn: active.filter((m) => m.supervisorClockIn).length,
    noSite: active.filter((m) => m.siteIds.length === 0).length,
  };
}

/** The signed-in line manager's team, counted. */
export async function loadTeamSummary(
  supabase: Client,
  organisationId: string,
): Promise<TeamSummary> {
  return summariseTeam(await loadTeamMembers(supabase, organisationId));
}

/**
 * Names for workers the caller may see, whatever their role: `public.workers` for the roles
 * that read it (and a login's own row), then `my_reportees` for anyone it didn't return, which
 * is how a line manager names their reportees. Ids the caller may not see are left out.
 */
export async function loadVisibleWorkerNames(
  supabase: Client,
  organisationId: string,
  ids: readonly string[],
): Promise<Map<string, { firstName: string; lastName: string; staffId: string }>> {
  const wanted = [...new Set(ids)];
  const names = new Map<string, { firstName: string; lastName: string; staffId: string }>();
  if (wanted.length === 0) return names;
  const { data, error } = await supabase
    .from("workers")
    .select("id, staff_id, first_name, last_name")
    .eq("organisation_id", organisationId)
    .in("id", wanted);
  if (error) throw new Error(`Could not read workers (${error.code})`);
  for (const w of data ?? []) {
    names.set(w.id, { firstName: w.first_name, lastName: w.last_name, staffId: w.staff_id });
  }
  if (names.size === wanted.length) return names;
  const missing = new Set(wanted.filter((id) => !names.has(id)));
  for (const m of await loadTeamMembers(supabase, organisationId)) {
    if (missing.has(m.id)) {
      names.set(m.id, { firstName: m.firstName, lastName: m.lastName, staffId: m.staffId });
    }
  }
  return names;
}
