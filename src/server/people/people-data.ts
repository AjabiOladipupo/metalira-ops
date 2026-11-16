import "server-only";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import { MANAGER_ROLES, ROLE_LABELS, isRole, type Role } from "@/lib/roles";
import {
  encodeLineManager,
  fullName,
  isMapped,
  matchesPeopleSearch,
  type EmploymentType,
  type LineManagerRef,
} from "@/lib/people";
import type { Kobo } from "@/lib/money";
import type { Database } from "@/types/db";

import { listPayRates, koboFromText, type PayRateVersion } from "./pay-rates";

/**
 * Reads for the People screens (slice 1.5). Every query runs with the signed-in user's own
 * client and is scoped to the active organisation, so RLS decides what each role sees (line
 * managers see only their reportees and no pay; ops_manager and finance read without writing).
 *
 * Personal data never leaves here in clear: lists read the `_last4` columns, and the profile
 * turns each `_enc` column into "on file or not" before returning. Full values are revealed one
 * at a time through `revealPii` (src/server/people/pii-access.ts), which audits each reveal.
 */

type Client = SupabaseClient<Database>;

const PAGE = 1000;

/** Every row a query returns, a page at a time (PostgREST caps one read at 1000 rows). */
async function readAll<T>(
  what: string,
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: PostgrestError | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read ${what}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

// ---------------------------------------------------------------------------
// Names of the things a worker points at
// ---------------------------------------------------------------------------

export interface ManagerUser {
  membershipId: string;
  name: string;
  role: Role;
}

/**
 * Manager-app users who can be a line manager without being on the worker list (owner decision
 * 3): a manager role and no worker record. Named from their profile; a user with no name yet is
 * shown by role.
 */
export async function loadManagerUsers(
  supabase: Client,
  organisationId: string,
): Promise<ManagerUser[]> {
  const { data, error } = await supabase
    .from("memberships")
    .select("id, user_id, role")
    .eq("organisation_id", organisationId)
    .in("role", [...MANAGER_ROLES])
    .is("worker_id", null);
  if (error) throw new Error(`Could not read managers: ${error.message}`);
  const memberships = data ?? [];
  if (memberships.length === 0) return [];

  const { data: profiles, error: profileError } = await supabase
    .from("profiles")
    .select("user_id, full_name")
    .in(
      "user_id",
      memberships.map((m) => m.user_id),
    );
  if (profileError) throw new Error(`Could not read manager names: ${profileError.message}`);
  const names = new Map((profiles ?? []).map((p) => [p.user_id, p.full_name?.trim() || null]));

  return memberships
    .flatMap((m) =>
      isRole(m.role)
        ? [
            {
              membershipId: m.id,
              role: m.role,
              name: names.get(m.user_id) ?? `${ROLE_LABELS[m.role]} (no name yet)`,
            },
          ]
        : [],
    )
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

interface NamedRow {
  id: string;
  name: string;
}

async function loadNames(
  supabase: Client,
  table: "departments" | "sites" | "projects" | "clients",
  organisationId: string,
): Promise<Map<string, string>> {
  const rows = await readAll<NamedRow>(table, (from, to) =>
    supabase
      .from(table)
      .select("id, name")
      .eq("organisation_id", organisationId)
      .order("id")
      .range(from, to),
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

interface AssignmentRow {
  worker_id: string;
  client_id: string | null;
  site_id: string | null;
  project_id: string | null;
  effective_from: string;
  effective_to: string | null;
}

/** Assignments in force on `today` (the current mapping), for one worker or everyone. */
async function loadCurrentAssignments(
  supabase: Client,
  organisationId: string,
  today: string,
  workerId?: string,
): Promise<AssignmentRow[]> {
  return readAll<AssignmentRow>("assignments", (from, to) => {
    let query = supabase
      .from("worker_assignments")
      .select("worker_id, client_id, site_id, project_id, effective_from, effective_to")
      .eq("organisation_id", organisationId)
      .lte("effective_from", today)
      .or(`effective_to.is.null,effective_to.gte.${today}`);
    if (workerId) query = query.eq("worker_id", workerId);
    return query.order("id").range(from, to);
  });
}

function unique(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => v !== null))];
}

// ---------------------------------------------------------------------------
// The People list
// ---------------------------------------------------------------------------

export interface PeopleRow {
  id: string;
  staffId: string;
  firstName: string;
  lastName: string;
  name: string;
  jobTitle: string | null;
  departmentId: string | null;
  departmentName: string | null;
  lineManagerName: string | null;
  siteNames: string[];
  projectNames: string[];
  mapped: boolean;
}

export interface DepartmentSummary {
  id: string;
  name: string;
  headWorkerId: string | null;
  headName: string | null;
  /** Active employees in the department. */
  count: number;
}

export interface PeopleDirectory {
  /** Active employees matching the search and department filter, by name. */
  rows: PeopleRow[];
  /** Active employees in the company, before filters. */
  activeCount: number;
  /** Active employees missing a department, line manager or site, before filters. */
  unmappedCount: number;
  /** Active employees with no department, before filters. */
  noDepartmentCount: number;
  departments: DepartmentSummary[];
}

interface WorkerListRow {
  id: string;
  staff_id: string;
  first_name: string;
  last_name: string;
  job_title: string | null;
  department_id: string | null;
  line_manager_worker_id: string | null;
  line_manager_membership_id: string | null;
  status: Database["public"]["Enums"]["worker_status"];
}

/** A department filter value: a department id, or "none" for employees without one. */
export const NO_DEPARTMENT = "none";

/**
 * The active employees, their department, line manager, current site and projects, and the
 * department tiles. Filters apply to `rows` only; the counts are company-wide.
 */
export async function loadPeopleDirectory(
  supabase: Client,
  organisationId: string,
  today: string,
  filters: { query?: string; departmentId?: string } = {},
): Promise<PeopleDirectory> {
  const [workers, departments, sites, projects, assignments, managers] = await Promise.all([
    readAll<WorkerListRow>("employees", (from, to) =>
      supabase
        .from("workers")
        .select(
          "id, staff_id, first_name, last_name, job_title, department_id, line_manager_worker_id, line_manager_membership_id, status",
        )
        .eq("organisation_id", organisationId)
        .order("id")
        .range(from, to),
    ),
    readAll<{ id: string; name: string; head_worker_id: string | null }>(
      "departments",
      (from, to) =>
        supabase
          .from("departments")
          .select("id, name, head_worker_id")
          .eq("organisation_id", organisationId)
          .order("id")
          .range(from, to),
    ),
    loadNames(supabase, "sites", organisationId),
    loadNames(supabase, "projects", organisationId),
    loadCurrentAssignments(supabase, organisationId, today),
    loadManagerUsers(supabase, organisationId),
  ]);

  const workerName = new Map(
    workers.map((w) => [w.id, fullName({ firstName: w.first_name, lastName: w.last_name })]),
  );
  const managerName = new Map(managers.map((m) => [m.membershipId, m.name]));
  const departmentName = new Map(departments.map((d) => [d.id, d.name]));
  const byWorker = new Map<string, AssignmentRow[]>();
  for (const a of assignments) {
    const list = byWorker.get(a.worker_id) ?? [];
    list.push(a);
    byWorker.set(a.worker_id, list);
  }

  const active = workers.filter((w) => w.status === "active");
  const all: PeopleRow[] = active.map((w) => {
    const current = byWorker.get(w.id) ?? [];
    const siteIds = unique(current.map((a) => a.site_id));
    const lineManagerName = w.line_manager_worker_id
      ? (workerName.get(w.line_manager_worker_id) ?? null)
      : w.line_manager_membership_id
        ? (managerName.get(w.line_manager_membership_id) ?? "Manager")
        : null;
    return {
      id: w.id,
      staffId: w.staff_id,
      firstName: w.first_name,
      lastName: w.last_name,
      name: fullName({ firstName: w.first_name, lastName: w.last_name }),
      jobTitle: w.job_title,
      departmentId: w.department_id,
      departmentName: w.department_id ? (departmentName.get(w.department_id) ?? null) : null,
      lineManagerName,
      siteNames: siteIds.map((id) => sites.get(id) ?? "Site").sort(),
      projectNames: unique(current.map((a) => a.project_id))
        .map((id) => projects.get(id) ?? "Project")
        .sort(),
      mapped: isMapped({
        departmentId: w.department_id,
        hasLineManager: Boolean(w.line_manager_worker_id || w.line_manager_membership_id),
        siteIds,
      }),
    };
  });

  const counts = new Map<string, number>();
  for (const row of all) {
    if (row.departmentId) counts.set(row.departmentId, (counts.get(row.departmentId) ?? 0) + 1);
  }

  const query = filters.query ?? "";
  const dept = filters.departmentId;
  const rows = all
    .filter((r) => matchesPeopleSearch(r, query))
    .filter((r) =>
      !dept ? true : dept === NO_DEPARTMENT ? r.departmentId === null : r.departmentId === dept,
    )
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
        a.staffId.localeCompare(b.staffId),
    );

  return {
    rows,
    activeCount: all.length,
    unmappedCount: all.filter((r) => !r.mapped).length,
    noDepartmentCount: all.filter((r) => r.departmentId === null).length,
    departments: departments
      .map((d) => ({
        id: d.id,
        name: d.name,
        headWorkerId: d.head_worker_id,
        headName: d.head_worker_id ? (workerName.get(d.head_worker_id) ?? null) : null,
        count: counts.get(d.id) ?? 0,
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}

// ---------------------------------------------------------------------------
// Choices for the forms
// ---------------------------------------------------------------------------

export interface Option {
  value: string;
  label: string;
}

export interface WorkerFormOptions {
  departments: Option[];
  /** Workers (`w:<id>`) and manager-app users (`m:<id>`) in one list. */
  lineManagers: Option[];
}

/** Departments and line-manager choices. `exceptWorkerId` leaves a worker out of their own list. */
export async function loadWorkerFormOptions(
  supabase: Client,
  organisationId: string,
  exceptWorkerId?: string,
): Promise<WorkerFormOptions> {
  const [departments, workers, managers] = await Promise.all([
    loadNames(supabase, "departments", organisationId),
    readAll<{ id: string; staff_id: string; first_name: string; last_name: string }>(
      "employees",
      (from, to) =>
        supabase
          .from("workers")
          .select("id, staff_id, first_name, last_name")
          .eq("organisation_id", organisationId)
          .eq("status", "active")
          .order("id")
          .range(from, to),
    ),
    loadManagerUsers(supabase, organisationId),
  ]);

  const byName = (a: Option, b: Option) =>
    a.label.localeCompare(b.label, "en", { sensitivity: "base" });

  return {
    departments: [...departments].map(([value, label]) => ({ value, label })).sort(byName),
    lineManagers: [
      ...managers.map((m) => ({
        value: encodeLineManager({ kind: "membership", id: m.membershipId }),
        label: `${m.name} · ${ROLE_LABELS[m.role]}`,
      })),
      ...workers
        .filter((w) => w.id !== exceptWorkerId)
        .map((w) => ({
          value: encodeLineManager({ kind: "worker", id: w.id }),
          label: `${fullName({ firstName: w.first_name, lastName: w.last_name })} · ${w.staff_id}`,
        })),
    ].sort(byName),
  };
}

/** Active employees as department-head choices, by name. */
export async function loadHeadOptions(supabase: Client, organisationId: string): Promise<Option[]> {
  const workers = await readAll<{
    id: string;
    staff_id: string;
    first_name: string;
    last_name: string;
  }>("employees", (from, to) =>
    supabase
      .from("workers")
      .select("id, staff_id, first_name, last_name")
      .eq("organisation_id", organisationId)
      .eq("status", "active")
      .order("id")
      .range(from, to),
  );
  return workers
    .map((w) => ({
      value: w.id,
      label: `${fullName({ firstName: w.first_name, lastName: w.last_name })} · ${w.staff_id}`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "en", { sensitivity: "base" }));
}

// ---------------------------------------------------------------------------
// One worker's profile
// ---------------------------------------------------------------------------

export interface WorkerProfile {
  id: string;
  staffId: string;
  firstName: string;
  lastName: string;
  name: string;
  phone: string | null;
  email: string | null;
  jobTitle: string | null;
  departmentId: string | null;
  departmentName: string | null;
  lineManager: LineManagerRef;
  lineManagerName: string | null;
  employmentType: EmploymentType;
  startDate: string;
  endDate: string | null;
  status: Database["public"]["Enums"]["worker_status"];
  bankName: string | null;
  accountName: string | null;
  /** Last four digits only; the number itself is revealed on request. */
  bankAccountLast4: string | null;
  ninOnFile: boolean;
  tin: string | null;
  taxState: string | null;
  pfaName: string | null;
  rsaPinOnFile: boolean;
  rsaPinLast4: string | null;
  nhfOptIn: boolean;
  annualRentDeclared: Kobo | null;
  nextOfKinName: string | null;
  nextOfKinPhone: string | null;
  needsPayDetails: boolean;
  supervisorClockIn: boolean;
  siteNames: string[];
  projectNames: string[];
  mapped: boolean;
  /** Pay versions, oldest first. Empty when the caller's role sees no pay. */
  payRates: PayRateVersion[];
}

const PROFILE_COLUMNS =
  "id, staff_id, first_name, last_name, phone, email, job_title, department_id, line_manager_worker_id, line_manager_membership_id, employment_type, start_date, end_date, status, bank_name, account_name, bank_account_last4, nin_enc, tin, tax_state, pfa_name, rsa_pin_enc, rsa_pin_last4, nhf_opt_in, annual_rent_declared_kobo::text, next_of_kin_name, next_of_kin_phone, needs_pay_details, supervisor_clock_in" as const;

/** One worker as the People screens show them, or null when RLS hides them or none exists. */
export async function loadWorkerProfile(
  supabase: Client,
  organisationId: string,
  workerId: string,
  today: string,
): Promise<WorkerProfile | null> {
  const { data: w, error } = await supabase
    .from("workers")
    .select(PROFILE_COLUMNS)
    .eq("organisation_id", organisationId)
    .eq("id", workerId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the employee: ${error.message}`);
  if (!w) return null;

  const [department, lineManagerName, assignments, sites, projects, payRates] = await Promise.all([
    w.department_id
      ? supabase
          .from("departments")
          .select("name")
          .eq("organisation_id", organisationId)
          .eq("id", w.department_id)
          .maybeSingle()
          .then(({ data }) => data?.name ?? null)
      : Promise.resolve(null),
    lineManagerLabel(supabase, organisationId, w),
    loadCurrentAssignments(supabase, organisationId, today, workerId),
    loadNames(supabase, "sites", organisationId),
    loadNames(supabase, "projects", organisationId),
    listPayRates(supabase, organisationId, workerId),
  ]);

  const siteIds = unique(assignments.map((a) => a.site_id));
  const lineManager: LineManagerRef = w.line_manager_worker_id
    ? { kind: "worker", id: w.line_manager_worker_id }
    : w.line_manager_membership_id
      ? { kind: "membership", id: w.line_manager_membership_id }
      : null;

  return {
    id: w.id,
    staffId: w.staff_id,
    firstName: w.first_name,
    lastName: w.last_name,
    name: fullName({ firstName: w.first_name, lastName: w.last_name }),
    phone: w.phone,
    email: w.email,
    jobTitle: w.job_title,
    departmentId: w.department_id,
    departmentName: department,
    lineManager,
    lineManagerName,
    employmentType: w.employment_type,
    startDate: w.start_date,
    endDate: w.end_date,
    status: w.status,
    bankName: w.bank_name,
    accountName: w.account_name,
    bankAccountLast4: w.bank_account_last4,
    ninOnFile: w.nin_enc !== null,
    tin: w.tin,
    taxState: w.tax_state,
    pfaName: w.pfa_name,
    rsaPinOnFile: w.rsa_pin_enc !== null,
    rsaPinLast4: w.rsa_pin_last4,
    nhfOptIn: w.nhf_opt_in,
    annualRentDeclared: koboFromText(w.annual_rent_declared_kobo),
    nextOfKinName: w.next_of_kin_name,
    nextOfKinPhone: w.next_of_kin_phone,
    needsPayDetails: w.needs_pay_details,
    supervisorClockIn: w.supervisor_clock_in,
    siteNames: siteIds.map((id) => sites.get(id) ?? "Site").sort(),
    projectNames: unique(assignments.map((a) => a.project_id))
      .map((id) => projects.get(id) ?? "Project")
      .sort(),
    mapped: isMapped({
      departmentId: w.department_id,
      hasLineManager: lineManager !== null,
      siteIds,
    }),
    payRates,
  };
}

async function lineManagerLabel(
  supabase: Client,
  organisationId: string,
  w: { line_manager_worker_id: string | null; line_manager_membership_id: string | null },
): Promise<string | null> {
  if (w.line_manager_worker_id) {
    const { data } = await supabase
      .from("workers")
      .select("first_name, last_name")
      .eq("organisation_id", organisationId)
      .eq("id", w.line_manager_worker_id)
      .maybeSingle();
    return data ? fullName({ firstName: data.first_name, lastName: data.last_name }) : null;
  }
  if (w.line_manager_membership_id) {
    const managers = await loadManagerUsers(supabase, organisationId);
    return managers.find((m) => m.membershipId === w.line_manager_membership_id)?.name ?? "Manager";
  }
  return null;
}
