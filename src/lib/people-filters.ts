import { matchesPeopleSearch, type PayType } from "@/lib/people";

/**
 * People list filters (slice U.1): pure and browser-safe. The filters live in the URL next to
 * the search, the page size and the page, so a filtered list is a shareable link:
 *
 *   q        name or staff ID (the existing search)
 *   dept     department id, or "none"
 *   site     site id (where the person is mapped now, or from the next shift), or "none"
 *   manager  line manager as the forms encode it (`w:<worker>` or `m:<membership>`), or "none"
 *   title    job title (exact, ignoring case and spaces), or "none"
 *   role     app access: owner, admin, hr, finance, ops_manager, line_manager, supervisor, worker
 *   type     employment type as paid: monthly, daily or hourly (the pay version in force today)
 *   status   active (the default), ended or invited (active, invited, not signed in yet)
 *
 * Filters combine with AND. They only ever narrow the rows the caller may read: a line manager
 * filters their own reportees, never the company.
 */

export const PEOPLE_STATUSES = ["active", "ended", "invited"] as const;
export type PeopleStatus = (typeof PEOPLE_STATUSES)[number];

export const PEOPLE_STATUS_LABELS: Record<PeopleStatus, string> = {
  active: "Active",
  ended: "Ended",
  invited: "Invited",
};

/** App access, a separate thing from the job title. `supervisor` is a worker login with reportees. */
export const APP_ROLES = [
  "owner",
  "admin",
  "hr",
  "finance",
  "ops_manager",
  "line_manager",
  "supervisor",
  "worker",
] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const APP_ROLE_LABELS: Record<AppRole, string> = {
  owner: "Owner",
  admin: "Admin",
  hr: "HR",
  finance: "Finance",
  ops_manager: "Operations manager",
  line_manager: "Line manager",
  supervisor: "Supervisor",
  worker: "Worker",
};

export const PAY_TYPES = ["monthly", "daily", "hourly"] as const satisfies readonly PayType[];

/** The value that matches people with nothing set (no department, site, line manager or title). */
export const NONE = "none";

export interface PeopleFilters {
  q: string;
  dept: string;
  site: string;
  manager: string;
  title: string;
  role: AppRole | "";
  type: PayType | "";
  status: PeopleStatus;
}

export const DEFAULT_STATUS: PeopleStatus = "active";

export const EMPTY_FILTERS: PeopleFilters = {
  q: "",
  dept: "",
  site: "",
  manager: "",
  title: "",
  role: "",
  type: "",
  status: DEFAULT_STATUS,
};

type RawParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

function oneOf<T extends string>(value: string, options: readonly T[]): T | "" {
  return (options as readonly string[]).includes(value) ? (value as T) : "";
}

/** An id-like value: a uuid, or `none`. Anything else is dropped. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function idOrNone(value: string): string {
  return value === NONE || ID.test(value) ? value : "";
}

function managerValue(value: string): string {
  if (value === NONE) return value;
  const match = /^([wm]):(.+)$/.exec(value);
  return match && ID.test(match[2]!) ? value : "";
}

/** Collapses spaces so "Security  guard " and "security guard" are one title. */
export function normaliseTitle(title: string | null | undefined): string {
  return (title ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** The filters in a URL's search params. Unknown or malformed values are ignored. */
export function parsePeopleFilters(params: RawParams): PeopleFilters {
  const title = first(params.title).replace(/\s+/g, " ").slice(0, 120);
  return {
    q: first(params.q).slice(0, 100),
    dept: idOrNone(first(params.dept)),
    site: idOrNone(first(params.site)),
    manager: managerValue(first(params.manager)),
    title,
    role: oneOf(first(params.role), APP_ROLES),
    type: oneOf(first(params.type), PAY_TYPES),
    status: oneOf(first(params.status), PEOPLE_STATUSES) || DEFAULT_STATUS,
  };
}

/** The filters as search params, in a fixed order, leaving out blanks and the default status. */
export function peopleFilterParams(filters: PeopleFilters): URLSearchParams {
  const search = new URLSearchParams();
  if (filters.q) search.set("q", filters.q);
  if (filters.dept) search.set("dept", filters.dept);
  if (filters.site) search.set("site", filters.site);
  if (filters.manager) search.set("manager", filters.manager);
  if (filters.title) search.set("title", filters.title);
  if (filters.role) search.set("role", filters.role);
  if (filters.type) search.set("type", filters.type);
  if (filters.status !== DEFAULT_STATUS) search.set("status", filters.status);
  return search;
}

/** How many filters (search excluded) differ from the defaults. */
export function activeFilterCount(filters: PeopleFilters): number {
  return (
    [filters.dept, filters.site, filters.manager, filters.title, filters.role, filters.type].filter(
      Boolean,
    ).length + (filters.status !== DEFAULT_STATUS ? 1 : 0)
  );
}

/** True when the search or any filter narrows the list. */
export function isFiltered(filters: PeopleFilters): boolean {
  return Boolean(filters.q) || activeFilterCount(filters) > 0;
}

/** What a filter looks at, for one person. */
export interface FilterablePerson {
  firstName: string;
  lastName: string;
  staffId: string;
  departmentId: string | null;
  siteIds: readonly string[];
  /** Encoded as the forms do (`w:<id>`, `m:<id>`), or "" for none. */
  lineManager: string;
  jobTitle: string | null;
  /** App access, or null without a login. */
  appRole: AppRole | null;
  /** The pay version in force today, or null when unknown to the caller or not set. */
  payType: PayType | null;
  status: "active" | "ended";
  /** Active, invited to the worker app and not signed up yet. */
  invited: boolean;
}

/** Does this person pass every filter? */
export function matchesPeopleFilters(person: FilterablePerson, filters: PeopleFilters): boolean {
  if (!matchesPeopleSearch(person, filters.q)) return false;

  if (filters.status === "ended" && person.status !== "ended") return false;
  if (filters.status === "active" && person.status !== "active") return false;
  if (filters.status === "invited" && !(person.status === "active" && person.invited)) return false;

  if (filters.dept) {
    if (filters.dept === NONE ? person.departmentId !== null : person.departmentId !== filters.dept)
      return false;
  }
  if (filters.site) {
    if (filters.site === NONE ? person.siteIds.length > 0 : !person.siteIds.includes(filters.site))
      return false;
  }
  if (filters.manager) {
    if (
      filters.manager === NONE ? person.lineManager !== "" : person.lineManager !== filters.manager
    )
      return false;
  }
  if (filters.title) {
    const title = normaliseTitle(person.jobTitle);
    if (filters.title === NONE ? title !== "" : title !== normaliseTitle(filters.title))
      return false;
  }
  if (filters.role && person.appRole !== filters.role) return false;
  if (filters.type && person.payType !== filters.type) return false;
  return true;
}

/**
 * App access for a person on the worker list: the role of the login linked to their record, with
 * a worker login that has reportees shown as a supervisor (slice 4.7b). Null without a login.
 */
export function appRoleOf(
  membershipRole: string | null | undefined,
  hasReportees: boolean,
): AppRole | null {
  if (!membershipRole) return null;
  if (membershipRole === "worker") return hasReportees ? "supervisor" : "worker";
  return oneOf(membershipRole, APP_ROLES) || null;
}
