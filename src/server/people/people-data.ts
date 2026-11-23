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
import { loadTeamMember } from "./team";

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

/**
 * The mapping as it stands: assignments that have not ended by the end of `today`, for one
 * worker or everyone. That includes rows saved for the next shift (slice 1.6 starts site and
 * project changes tomorrow), so a change shows, and counts toward Mapped, as soon as it is saved.
 */
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
      .or(`effective_to.is.null,effective_to.gt.${today}`);
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
  /** The line-manager choice as the forms encode it (`w:<id>`, `m:<id>`, or empty). */
  lineManager: string;
  siteIds: string[];
  siteNames: string[];
  projectIds: string[];
  projectNames: string[];
  /** The first day of site or project changes saved for later (the next shift), if any. */
  changesFrom: string | null;
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
  /** The active employee asked for by `selectedId`, whatever the filters, or null. */
  selected: PeopleRow | null;
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
  filters: { query?: string; departmentId?: string; selectedId?: string } = {},
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
    const projectIds = unique(current.map((a) => a.project_id));
    const later = current.map((a) => a.effective_from).filter((from) => from > today);
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
      lineManager: encodeLineManager(
        w.line_manager_worker_id
          ? { kind: "worker", id: w.line_manager_worker_id }
          : w.line_manager_membership_id
            ? { kind: "membership", id: w.line_manager_membership_id }
            : null,
      ),
      siteIds,
      siteNames: siteIds.map((id) => sites.get(id) ?? "Site").sort(),
      projectIds,
      projectNames: projectIds.map((id) => projects.get(id) ?? "Project").sort(),
      changesFrom: later.sort()[0] ?? null,
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
    selected: filters.selectedId ? (all.find((r) => r.id === filters.selectedId) ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// Mapping choices (slice 1.6)
// ---------------------------------------------------------------------------

export interface MappingTargets {
  /** Sites, labelled "Site · Client". */
  sites: Option[];
  /** Projects, labelled "Project · Client". */
  projects: Option[];
}

/**
 * The sites and projects a worker can be mapped to, by name, with their client for context.
 * Archived clients and archived sites are left out (slice 2.2), except the ones in `keep` (the
 * worker's current mapping), so saving the panel never drops a mapping silently.
 */
export async function loadMappingTargets(
  supabase: Client,
  organisationId: string,
  keep: readonly string[] = [],
): Promise<MappingTargets> {
  const [clients, sites, projects] = await Promise.all([
    readAll<{ id: string; name: string; status: string }>("clients", (from, to) =>
      supabase
        .from("clients")
        .select("id, name, status")
        .eq("organisation_id", organisationId)
        .order("id")
        .range(from, to),
    ),
    readAll<{ id: string; name: string; client_id: string; status: string }>("sites", (from, to) =>
      supabase
        .from("sites")
        .select("id, name, client_id, status")
        .eq("organisation_id", organisationId)
        .order("id")
        .range(from, to),
    ),
    readAll<{ id: string; name: string; client_id: string }>("projects", (from, to) =>
      supabase
        .from("projects")
        .select("id, name, client_id")
        .eq("organisation_id", organisationId)
        .order("id")
        .range(from, to),
    ),
  ]);
  const clientOf = new Map(clients.map((c) => [c.id, c]));
  const kept = new Set(keep);
  const open = (row: { id: string; client_id: string; status?: string }) =>
    kept.has(row.id) ||
    (row.status !== "archived" && clientOf.get(row.client_id)?.status !== "archived");
  const toOption = (row: { id: string; name: string; client_id: string }): Option => {
    const client = clientOf.get(row.client_id)?.name;
    return { value: row.id, label: client ? `${row.name} · ${client}` : row.name };
  };
  const byLabel = (a: Option, b: Option) =>
    a.label.localeCompare(b.label, "en", { sensitivity: "base" });
  return {
    sites: sites.filter(open).map(toOption).sort(byLabel),
    projects: projects.filter(open).map(toOption).sort(byLabel),
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
  /** The bank's code, for details saved from slice 2.3b on (null before, and from imports). */
  bankCode: string | null;
  /** The last account name check of the details on file (slice 2.3b), or null: not checked. */
  bankCheck: { accountName: string; at: string; test: boolean } | null;
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
  /** The worker's usual working days (ISO 1 to 7), or null for the company's week (slice 4.1). */
  usualWorkDays: number[] | null;
  siteNames: string[];
  projectNames: string[];
  mapped: boolean;
  /** Pay versions, oldest first. Empty when the caller's role sees no pay (only owner, hr, finance see it). */
  payRates: PayRateVersion[];
}

const PROFILE_COLUMNS =
  "id, staff_id, first_name, last_name, phone, email, job_title, department_id, line_manager_worker_id, line_manager_membership_id, employment_type, start_date, end_date, status, bank_name, account_name, bank_account_last4, bank_code, bank_checked_name, bank_checked_at, bank_checked_source, nin_enc, tin, tax_state, pfa_name, rsa_pin_enc, rsa_pin_last4, nhf_opt_in, annual_rent_declared_kobo::text, next_of_kin_name, next_of_kin_phone, needs_pay_details, supervisor_clock_in, usual_work_days" as const;

/** The columns every reader of a profile gets, a line manager included (slice 4.0). */
type SafeProfileRow = {
  id: string;
  staff_id: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  email: string | null;
  job_title: string | null;
  department_id: string | null;
  line_manager_worker_id: string | null;
  line_manager_membership_id: string | null;
  employment_type: WorkerProfile["employmentType"];
  start_date: string;
  end_date: string | null;
  status: WorkerProfile["status"];
  supervisor_clock_in: boolean;
  usual_work_days: number[] | null;
};

/** Bank, tax, pension, rent, next of kin and pay flags: never read for a line manager. */
type SensitiveProfileColumns = {
  bank_name: string | null;
  account_name: string | null;
  bank_account_last4: string | null;
  bank_code: string | null;
  bank_checked_name: string | null;
  bank_checked_at: string | null;
  bank_checked_source: string | null;
  nin_enc: unknown;
  tin: string | null;
  tax_state: string | null;
  pfa_name: string | null;
  rsa_pin_enc: unknown;
  rsa_pin_last4: string | null;
  nhf_opt_in: boolean;
  annual_rent_declared_kobo: string | null;
  next_of_kin_name: string | null;
  next_of_kin_phone: string | null;
  needs_pay_details: boolean;
};

/**
 * A profile as read: the full row (`public.workers`, for the roles that read it), or a line
 * manager's narrow one from public.my_reportees (slice 4.0) with no sensitive columns at all and
 * the line manager's name as that read gives it.
 */
type ProfileRead =
  | { kind: "full"; row: SafeProfileRow & SensitiveProfileColumns }
  | { kind: "team"; row: SafeProfileRow; lineManagerName: string | null };

async function loadProfileRow(
  supabase: Client,
  organisationId: string,
  workerId: string,
  limited: boolean,
): Promise<ProfileRead | null> {
  if (!limited) {
    const { data, error } = await supabase
      .from("workers")
      .select(PROFILE_COLUMNS)
      .eq("organisation_id", organisationId)
      .eq("id", workerId)
      .maybeSingle();
    if (error) throw new Error(`Could not read the employee: ${error.message}`);
    return data ? { kind: "full", row: data } : null;
  }
  // A line manager reads their reportee through public.my_reportees (slice 4.0): safe columns
  // only, and no row at all for anyone who doesn't report to them.
  const member = await loadTeamMember(supabase, organisationId, workerId);
  if (!member) return null;
  return {
    kind: "team",
    lineManagerName: member.lineManagerName,
    row: {
      id: member.id,
      staff_id: member.staffId,
      first_name: member.firstName,
      last_name: member.lastName,
      phone: member.phone,
      email: member.email,
      job_title: member.jobTitle,
      department_id: member.departmentId,
      line_manager_worker_id: member.lineManagerWorkerId,
      line_manager_membership_id: member.lineManagerMembershipId,
      employment_type: member.employmentType,
      start_date: member.startDate,
      end_date: member.endDate,
      status: member.status,
      supervisor_clock_in: member.supervisorClockIn,
      usual_work_days: member.usualWorkDays,
    },
  };
}

export interface WorkerProfileOptions {
  /**
   * Who is reading. "manager" (the People screens) reads the line manager from the directory
   * and the pay history. "self" is the worker's own session in the worker app (slice 1.10): RLS
   * lets it read only its own row, so the line manager's name comes from public.my_line_manager
   * and no pay history is read (the Me screen shows none).
   */
  viewer?: "manager" | "self" | "line_manager";
  /**
   * Whether to read the pay history (owner, hr and finance: owner decision, 23 Nov 2026). RLS
   * returns no pay rows to anyone else anyway; this skips the read. Defaults to true for
   * "manager" so existing callers keep their behaviour under RLS.
   */
  seePay?: boolean;
}

/** One worker as the People screens show them, or null when RLS hides them or none exists. */
export async function loadWorkerProfile(
  supabase: Client,
  organisationId: string,
  workerId: string,
  today: string,
  { viewer = "manager", seePay = true }: WorkerProfileOptions = {},
): Promise<WorkerProfile | null> {
  const limited = viewer === "line_manager";
  const read = await loadProfileRow(supabase, organisationId, workerId, limited);
  if (!read) return null;
  const w = read.row;
  const x = read.kind === "full" ? read.row : null;

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
    viewer === "self"
      ? ownLineManagerName(supabase, organisationId)
      : read.kind === "team"
        ? Promise.resolve(read.lineManagerName ?? (w.line_manager_membership_id ? "Manager" : null))
        : lineManagerLabel(supabase, organisationId, w),
    loadCurrentAssignments(supabase, organisationId, today, workerId),
    loadNames(supabase, "sites", organisationId),
    loadNames(supabase, "projects", organisationId),
    viewer === "manager" && seePay
      ? listPayRates(supabase, organisationId, workerId)
      : Promise.resolve([]),
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
    bankName: x?.bank_name ?? null,
    accountName: x?.account_name ?? null,
    bankAccountLast4: x?.bank_account_last4 ?? null,
    bankCode: x?.bank_code ?? null,
    bankCheck:
      x?.bank_checked_name && x.bank_checked_at
        ? {
            accountName: x.bank_checked_name,
            at: x.bank_checked_at,
            test: x.bank_checked_source !== "bank",
          }
        : null,
    ninOnFile: x ? x.nin_enc !== null : false,
    tin: x?.tin ?? null,
    taxState: x?.tax_state ?? null,
    pfaName: x?.pfa_name ?? null,
    rsaPinOnFile: x ? x.rsa_pin_enc !== null : false,
    rsaPinLast4: x?.rsa_pin_last4 ?? null,
    nhfOptIn: x?.nhf_opt_in ?? false,
    annualRentDeclared: koboFromText(x?.annual_rent_declared_kobo ?? null),
    nextOfKinName: x?.next_of_kin_name ?? null,
    nextOfKinPhone: x?.next_of_kin_phone ?? null,
    needsPayDetails: x?.needs_pay_details ?? false,
    supervisorClockIn: w.supervisor_clock_in,
    usualWorkDays: w.usual_work_days,
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

/**
 * The signed-in worker's own line manager by name (public.my_line_manager), or null when none
 * is set. A manager-app line manager with no profile name comes back as null too; the screen
 * still knows one is set from the worker row.
 */
async function ownLineManagerName(
  supabase: Client,
  organisationId: string,
): Promise<string | null> {
  const { data, error } = await supabase.rpc("my_line_manager", {
    p_organisation_id: organisationId,
  });
  if (error) throw new Error(`Could not read the line manager: ${error.code}`);
  const row = data?.[0];
  return row?.has_line_manager ? (row.name ?? null) : null;
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
