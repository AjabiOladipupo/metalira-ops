import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { encodeLineManager } from "@/lib/people";
import {
  appRoleOf,
  matchesPeopleFilters,
  type FilterablePerson,
  type PeopleFilters,
  type PeopleStatus,
} from "@/lib/people-filters";
import type { ManagerRole } from "@/lib/roles";
import type { Database } from "@/types/db";

import type { PeopleExportRow } from "./export-csv";
import { filterOptionsFor, loadPeopleDirectory, type PeopleFilterOptions } from "./people-data";
import { loadTeamMembers, type TeamMember } from "./team";

/**
 * The people a caller may act on from the People list (slice U.1), in one shape for the filters,
 * the bulk actions and the export. Owner, admin, hr and ops_manager read `public.workers` under
 * RLS (the directory); a line manager reads only their reportees through `public.my_reportees`
 * (slice 4.0b), so filters and selections can only ever narrow that set, never widen it.
 */

type Client = SupabaseClient<Database>;

/** The roles that open the People list (src/lib/nav.ts). */
export const PEOPLE_READERS = [
  "owner",
  "admin",
  "hr",
  "ops_manager",
  "line_manager",
] as const satisfies readonly ManagerRole[];

export interface ScopedPerson extends FilterablePerson {
  id: string;
  name: string;
  departmentName: string | null;
  siteNames: string[];
  lineManagerName: string | null;
  employmentType: PeopleExportRow["employmentType"];
  startDate: string;
  endDate: string | null;
}

/** A reportee as a filterable person: app access from their login, no pay type, no invites. */
export function teamPerson(
  member: TeamMember,
  loginRole: string | null,
  hasReportees: boolean,
): ScopedPerson {
  return {
    id: member.id,
    name: `${member.firstName} ${member.lastName}`,
    firstName: member.firstName,
    lastName: member.lastName,
    staffId: member.staffId,
    jobTitle: member.jobTitle,
    departmentId: member.departmentId,
    departmentName: member.departmentName,
    siteIds: member.siteIds,
    siteNames: member.siteNames,
    lineManager: encodeLineManager(
      member.lineManagerWorkerId
        ? { kind: "worker", id: member.lineManagerWorkerId }
        : member.lineManagerMembershipId
          ? { kind: "membership", id: member.lineManagerMembershipId }
          : null,
    ),
    lineManagerName: member.lineManagerName ?? (member.lineManagerMembershipId ? "Manager" : null),
    appRole: appRoleOf(loginRole, hasReportees),
    payType: null,
    status: member.status,
    invited: false,
    employmentType: member.employmentType,
    startDate: member.startDate,
    endDate: member.endDate,
  };
}

/** The signed-in line manager's reportees, with app access read from their logins. */
export async function loadTeamPeople(
  supabase: Client,
  organisationId: string,
): Promise<{ people: ScopedPerson[]; members: TeamMember[] }> {
  const members = await loadTeamMembers(supabase, organisationId);
  if (members.length === 0) return { people: [], members };
  const { data, error } = await supabase
    .from("memberships")
    .select("worker_id, role")
    .eq("organisation_id", organisationId)
    .in(
      "worker_id",
      members.map((m) => m.id),
    );
  if (error) throw new Error(`Could not read your team's logins: ${error.message}`);
  const loginRole = new Map((data ?? []).map((m) => [m.worker_id, m.role as string]));
  // A reportee who line-manages another reportee (within the team the caller can see).
  const leads = new Set(
    members.flatMap((m) =>
      m.status === "active" && m.lineManagerWorkerId ? [m.lineManagerWorkerId] : [],
    ),
  );
  return {
    people: members.map((m) => teamPerson(m, loginRole.get(m.id) ?? null, leads.has(m.id))),
    members,
  };
}

/** The filter choices for a line manager's team. */
export function teamFilterOptions(people: readonly ScopedPerson[]): PeopleFilterOptions {
  const siteNames = new Map<string, string>();
  for (const p of people) {
    p.siteIds.forEach((id, i) => siteNames.set(id, p.siteNames[i] ?? "Site"));
  }
  return { ...filterOptionsFor(people, siteNames), payTypes: false, invited: false };
}

/** Every person the caller may read, active and ended, before filters. */
export async function loadScopedPeople(
  supabase: Client,
  organisationId: string,
  role: ManagerRole,
  today: string,
): Promise<ScopedPerson[]> {
  if (role === "line_manager") {
    return (await loadTeamPeople(supabase, organisationId)).people;
  }
  const directory = await loadPeopleDirectory(supabase, organisationId, today, {}, role);
  return directory.everyone;
}

/** What a bulk action acts on: ticked rows, or everyone matching the list's filters. */
export type PeopleSelection =
  { kind: "ids"; ids: readonly string[] } | { kind: "filters"; filters: PeopleFilters };

/**
 * The people a selection names, within the caller's scope: ids the caller can't read (another
 * company's, or a non-reportee for a line manager) are simply not there.
 */
export function selectPeople(
  people: readonly ScopedPerson[],
  selection: PeopleSelection,
): ScopedPerson[] {
  if (selection.kind === "ids") {
    const wanted = new Set(selection.ids);
    return people.filter((p) => wanted.has(p.id));
  }
  return people.filter((p) => matchesPeopleFilters(p, selection.filters));
}

/** A scoped person as an export row (work details only). */
export function toExportRow(person: ScopedPerson): PeopleExportRow {
  const status: PeopleStatus =
    person.status === "ended" ? "ended" : person.invited ? "invited" : "active";
  return {
    name: person.name,
    staffId: person.staffId,
    jobTitle: person.jobTitle,
    department: person.departmentName,
    sites: person.siteNames,
    lineManager: person.lineManagerName,
    employmentType: person.employmentType,
    status,
    startDate: person.startDate,
    endDate: person.endDate,
  };
}
