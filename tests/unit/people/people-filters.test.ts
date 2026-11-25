/**
 * Slice U.1: the People list filters. They are read from the URL (unknown values dropped),
 * written back in a fixed order without defaults, combine with AND, and only ever narrow a list:
 * a line manager filtering their reportees can never reach anyone else.
 */
import { describe, expect, it } from "vitest";

import {
  EMPTY_FILTERS,
  activeFilterCount,
  appRoleOf,
  isFiltered,
  matchesPeopleFilters,
  parsePeopleFilters,
  peopleFilterParams,
  type FilterablePerson,
  type PeopleFilters,
} from "@/lib/people-filters";
import { selectPeople, type ScopedPerson } from "@/server/people/people-scope";

const SITE_A = "11111111-1111-4111-8111-111111111111";
const SITE_B = "22222222-2222-4222-8222-222222222222";
const DEPT = "33333333-3333-4333-8333-333333333333";
const LM = "44444444-4444-4444-8444-444444444444";

function person(overrides: Partial<FilterablePerson> = {}): FilterablePerson {
  return {
    firstName: "Ada",
    lastName: "Obi",
    staffId: "EMP-0001",
    departmentId: DEPT,
    siteIds: [SITE_A],
    lineManager: `w:${LM}`,
    jobTitle: "Security guard",
    appRole: "worker",
    payType: "monthly",
    status: "active",
    invited: false,
    ...overrides,
  };
}

const filters = (f: Partial<PeopleFilters>): PeopleFilters => ({ ...EMPTY_FILTERS, ...f });

describe("parsePeopleFilters", () => {
  it("reads every filter from the URL", () => {
    expect(
      parsePeopleFilters({
        q: " ada ",
        dept: DEPT,
        site: SITE_A,
        manager: `m:${LM}`,
        title: "  Security   guard ",
        role: "line_manager",
        type: "daily",
        status: "ended",
      }),
    ).toEqual({
      q: "ada",
      dept: DEPT,
      site: SITE_A,
      manager: `m:${LM}`,
      title: "Security guard",
      role: "line_manager",
      type: "daily",
      status: "ended",
    });
  });

  it("drops unknown and malformed values and defaults the status to active", () => {
    expect(
      parsePeopleFilters({
        dept: "'; drop table workers",
        site: "not-a-uuid",
        manager: "x:123",
        role: "superuser",
        type: "weekly",
        status: "deleted",
      }),
    ).toEqual(EMPTY_FILTERS);
  });

  it("takes the first value of a repeated parameter and accepts none", () => {
    expect(parsePeopleFilters({ site: ["none", SITE_A], manager: "none" })).toMatchObject({
      site: "none",
      manager: "none",
    });
  });
});

describe("peopleFilterParams", () => {
  it("writes the filters in a fixed order, leaving out blanks and the default status", () => {
    expect(peopleFilterParams(filters({ q: "ada", site: SITE_A, role: "worker" })).toString()).toBe(
      `q=ada&site=${SITE_A}&role=worker`,
    );
    expect(peopleFilterParams(EMPTY_FILTERS).toString()).toBe("");
    expect(peopleFilterParams(filters({ status: "invited" })).toString()).toBe("status=invited");
  });

  it("round-trips through the parser", () => {
    const f = filters({
      q: "Obi",
      dept: "none",
      site: SITE_B,
      manager: `w:${LM}`,
      title: "Cleaner",
      role: "supervisor",
      type: "hourly",
      status: "ended",
    });
    expect(parsePeopleFilters(Object.fromEntries(peopleFilterParams(f)))).toEqual(f);
  });

  it("counts the filters that are on, search aside", () => {
    expect(activeFilterCount(filters({ q: "ada" }))).toBe(0);
    expect(isFiltered(filters({ q: "ada" }))).toBe(true);
    expect(activeFilterCount(filters({ site: SITE_A, status: "ended" }))).toBe(2);
    expect(isFiltered(EMPTY_FILTERS)).toBe(false);
  });
});

describe("matchesPeopleFilters", () => {
  it("shows active people by default and ended ones only when asked", () => {
    expect(matchesPeopleFilters(person(), EMPTY_FILTERS)).toBe(true);
    expect(matchesPeopleFilters(person({ status: "ended" }), EMPTY_FILTERS)).toBe(false);
    expect(matchesPeopleFilters(person({ status: "ended" }), filters({ status: "ended" }))).toBe(
      true,
    );
    expect(matchesPeopleFilters(person(), filters({ status: "ended" }))).toBe(false);
  });

  it("treats invited as active people with an open invite", () => {
    expect(matchesPeopleFilters(person({ invited: true }), filters({ status: "invited" }))).toBe(
      true,
    );
    expect(matchesPeopleFilters(person(), filters({ status: "invited" }))).toBe(false);
  });

  it("matches site, line manager, job title, role, department and pay type", () => {
    const p = person();
    expect(matchesPeopleFilters(p, filters({ site: SITE_A }))).toBe(true);
    expect(matchesPeopleFilters(p, filters({ site: SITE_B }))).toBe(false);
    expect(matchesPeopleFilters(p, filters({ manager: `w:${LM}` }))).toBe(true);
    expect(matchesPeopleFilters(p, filters({ manager: `m:${LM}` }))).toBe(false);
    expect(matchesPeopleFilters(p, filters({ title: "security GUARD" }))).toBe(true);
    expect(matchesPeopleFilters(p, filters({ title: "Cleaner" }))).toBe(false);
    expect(matchesPeopleFilters(p, filters({ role: "worker" }))).toBe(true);
    expect(matchesPeopleFilters(p, filters({ role: "hr" }))).toBe(false);
    expect(matchesPeopleFilters(p, filters({ dept: DEPT }))).toBe(true);
    expect(matchesPeopleFilters(p, filters({ type: "monthly" }))).toBe(true);
    expect(matchesPeopleFilters(p, filters({ type: "daily" }))).toBe(false);
  });

  it("matches nothing set with none", () => {
    const bare = person({ siteIds: [], lineManager: "", jobTitle: null, departmentId: null });
    const f = filters({ site: "none", manager: "none", title: "none", dept: "none" });
    expect(matchesPeopleFilters(bare, f)).toBe(true);
    expect(matchesPeopleFilters(person(), filters({ site: "none" }))).toBe(false);
  });

  it("combines filters with AND", () => {
    const p = person();
    expect(matchesPeopleFilters(p, filters({ site: SITE_A, role: "worker" }))).toBe(true);
    expect(matchesPeopleFilters(p, filters({ site: SITE_A, role: "hr" }))).toBe(false);
    expect(matchesPeopleFilters(p, filters({ q: "zzz", site: SITE_A }))).toBe(false);
  });
});

describe("appRoleOf", () => {
  it("reads app access from the login, with a worker who has reportees as a supervisor", () => {
    expect(appRoleOf(null, false)).toBeNull();
    expect(appRoleOf("worker", false)).toBe("worker");
    expect(appRoleOf("worker", true)).toBe("supervisor");
    expect(appRoleOf("hr", true)).toBe("hr");
    expect(appRoleOf("client_approver", false)).toBeNull();
  });
});

describe("selectPeople", () => {
  const scoped = (id: string, overrides: Partial<FilterablePerson> = {}): ScopedPerson => ({
    ...person(overrides),
    id,
    name: "Ada Obi",
    departmentName: null,
    siteNames: [],
    lineManagerName: null,
    employmentType: "permanent",
    startDate: "2025-01-06",
    endDate: null,
  });
  const team = [scoped("a"), scoped("b", { siteIds: [SITE_B] })];

  it("keeps only ids the caller can read: a selection can't widen the scope", () => {
    expect(selectPeople(team, { kind: "ids", ids: ["a", "outsider"] }).map((p) => p.id)).toEqual([
      "a",
    ]);
  });

  it("re-runs the filters over the caller's own people for all matching", () => {
    expect(
      selectPeople(team, { kind: "filters", filters: filters({ site: SITE_B }) }).map((p) => p.id),
    ).toEqual(["b"]);
    expect(selectPeople(team, { kind: "filters", filters: EMPTY_FILTERS })).toHaveLength(2);
  });
});
