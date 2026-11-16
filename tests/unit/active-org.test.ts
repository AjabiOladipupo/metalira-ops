import { describe, expect, it } from "vitest";

import {
  ACTIVE_ORG_COOKIE_OPTIONS,
  appAccess,
  managerMemberships,
  resolveActiveOrg,
  type Membership,
} from "@/server/identity/active-org";

const alpha: Membership = {
  organisationId: "a0000000-0000-4000-8000-000000000001",
  organisationName: "Alpha Guards",
  role: "owner",
};
const beta: Membership = {
  organisationId: "b0000000-0000-4000-8000-000000000002",
  organisationName: "beta Clean",
  role: "line_manager",
};
const gamma: Membership = {
  organisationId: "c0000000-0000-4000-8000-000000000003",
  organisationName: "Gamma Staffing",
  role: "worker",
};
const delta: Membership = {
  organisationId: "d0000000-0000-4000-8000-000000000004",
  organisationName: "Delta Estates",
  role: "client_approver",
};

describe("resolveActiveOrg", () => {
  it("uses the cookie when it names one of the user's manager memberships", () => {
    expect(resolveActiveOrg(beta.organisationId, [alpha, beta])).toEqual(beta);
  });

  it("ignores a cookie for an organisation the user does not belong to", () => {
    expect(resolveActiveOrg("e0000000-0000-4000-8000-000000000005", [beta, alpha])).toEqual(alpha);
  });

  it("ignores a cookie naming a worker membership", () => {
    expect(resolveActiveOrg(gamma.organisationId, [gamma, beta])).toEqual(beta);
  });

  it("falls back to the first manager organisation by name, case-insensitively", () => {
    expect(resolveActiveOrg(undefined, [beta, alpha])).toEqual(alpha);
    expect(resolveActiveOrg(null, [beta])).toEqual(beta);
  });

  it("returns null with no memberships or only worker and client roles", () => {
    expect(resolveActiveOrg(undefined, [])).toBeNull();
    expect(resolveActiveOrg(gamma.organisationId, [gamma, delta])).toBeNull();
  });

  it("lists manager memberships only, sorted by name", () => {
    expect(managerMemberships([gamma, beta, delta, alpha])).toEqual([alpha, beta]);
  });

  it("keeps the cookie httpOnly, lax and site-wide", () => {
    expect(ACTIVE_ORG_COOKIE_OPTIONS).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
  });
});

describe("appAccess", () => {
  const ownerAlpha = resolveActiveOrg(undefined, [alpha]);
  const lineBeta = resolveActiveOrg(undefined, [beta]);

  it("sends signed-out users to sign-in with the page they wanted", () => {
    expect(appAccess(false, null, [], "/app")).toEqual({ type: "redirect", to: "/sign-in" });
    expect(appAccess(false, null, [], "/app/payroll")).toEqual({
      type: "redirect",
      to: "/sign-in?next=%2Fapp%2Fpayroll",
    });
  });

  it("sends worker-only users to the worker app", () => {
    expect(appAccess(true, null, [gamma], "/app")).toEqual({ type: "redirect", to: "/m/sign-in" });
  });

  it("sends client approvers, and users with no organisation, to the no-access page", () => {
    expect(appAccess(true, null, [delta], "/app")).toEqual({ type: "redirect", to: "/no-access" });
    expect(appAccess(true, null, [], "/app")).toEqual({ type: "redirect", to: "/no-access" });
  });

  it("refuses a page the active role may not open", () => {
    expect(appAccess(true, lineBeta, [beta], "/app/payroll")).toEqual({
      type: "redirect",
      to: "/no-access",
    });
  });

  it("allows a page the active role may open", () => {
    expect(appAccess(true, lineBeta, [beta], "/app/timesheets")).toEqual({
      type: "allow",
      active: beta,
    });
    expect(appAccess(true, ownerAlpha, [alpha], "/app/payroll")).toEqual({
      type: "allow",
      active: alpha,
    });
  });
});
