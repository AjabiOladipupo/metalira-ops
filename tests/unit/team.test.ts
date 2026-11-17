import { describe, expect, it } from "vitest";

import { proxyDecision, safeNextPath } from "@/lib/auth/routes";
import { canAccessHref } from "@/lib/nav";
import {
  grantableRoles,
  inviteRefusal,
  inviteState,
  isInviteToken,
  memberRefusal,
  roleChangeRefusal,
  TEAM_ROLES,
  teamInvitePath,
} from "@/lib/team";

// Slice 1.12 rules. The database enforces the same ones (tests/rls/team.test.ts).

const owner = { userId: "u-owner", role: "owner" as const };
const admin = { userId: "u-admin", role: "admin" as const };
const hr = { userId: "u-hr", role: "hr" as const };

describe("who may grant which role", () => {
  it("offers the five manager roles, never owner, worker or client approver", () => {
    expect(TEAM_ROLES).toEqual(["admin", "hr", "finance", "ops_manager", "line_manager"]);
    expect(grantableRoles("owner")).toEqual([...TEAM_ROLES]);
  });

  it("lets only the owner grant admin", () => {
    expect(grantableRoles("admin")).not.toContain("admin");
    expect(inviteRefusal("owner", "admin")).toBeNull();
    expect(inviteRefusal("admin", "admin")).toBe("owner_only");
    expect(inviteRefusal("admin", "hr")).toBeNull();
  });

  it("refuses everyone below admin and roles outside the five", () => {
    for (const role of ["hr", "finance", "ops_manager", "line_manager", "worker"] as const) {
      expect(grantableRoles(role)).toEqual([]);
      expect(inviteRefusal(role, "hr")).toBe("not_allowed");
    }
    expect(inviteRefusal("owner", "owner")).toBe("bad_role");
    expect(inviteRefusal("owner", "worker")).toBe("bad_role");
    expect(inviteRefusal("owner", "client_approver")).toBe("bad_role");
  });
});

describe("changing and removing members", () => {
  it("never lets anyone change their own role or remove themselves", () => {
    expect(memberRefusal(admin, { userId: admin.userId, role: "admin" })).toBe("own_membership");
    expect(roleChangeRefusal(owner, { userId: owner.userId, role: "owner" }, "hr")).toBe(
      "own_membership",
    );
  });

  it("protects the owner from removal and demotion", () => {
    expect(memberRefusal(admin, { userId: "u-o2", role: "owner" })).toBe("owner_protected");
    expect(roleChangeRefusal(owner, { userId: "u-o2", role: "owner" }, "admin")).toBe(
      "owner_protected",
    );
  });

  it("lets only the owner change or remove an admin, or make someone admin", () => {
    const otherAdmin = { userId: "u-a2", role: "admin" as const };
    expect(memberRefusal(admin, otherAdmin)).toBe("owner_only");
    expect(memberRefusal(owner, otherAdmin)).toBeNull();
    expect(roleChangeRefusal(admin, { userId: "u-f", role: "finance" }, "admin")).toBe(
      "owner_only",
    );
    expect(roleChangeRefusal(owner, { userId: "u-f", role: "finance" }, "admin")).toBeNull();
    expect(roleChangeRefusal(admin, { userId: "u-f", role: "finance" }, "hr")).toBeNull();
  });

  it("leaves workers and client approvers to People", () => {
    expect(memberRefusal(owner, { userId: "u-w", role: "worker" })).toBe("not_a_manager");
    expect(memberRefusal(owner, { userId: "u-c", role: "client_approver" })).toBe("not_a_manager");
  });

  it("refuses non-managers, unknown roles and no-op changes", () => {
    expect(memberRefusal(hr, { userId: "u-f", role: "finance" })).toBe("not_allowed");
    expect(roleChangeRefusal(owner, { userId: "u-f", role: "finance" }, "owner")).toBe("bad_role");
    expect(roleChangeRefusal(owner, { userId: "u-f", role: "finance" }, "finance")).toBe(
      "same_role",
    );
  });
});

describe("invite states", () => {
  const now = new Date("2026-11-17T12:00:00Z");
  const base = { acceptedAt: null, revokedAt: null, expiresAt: "2026-11-24T12:00:00Z" };

  it("is pending until it expires", () => {
    expect(inviteState(base, now)).toBe("pending");
    expect(inviteState({ ...base, expiresAt: "2026-11-17T12:00:00Z" }, now)).toBe("expired");
    expect(inviteState({ ...base, expiresAt: "2026-11-10T12:00:00Z" }, now)).toBe("expired");
  });

  it("reports used and cancelled before expired", () => {
    const old = { ...base, expiresAt: "2026-11-10T12:00:00Z" };
    expect(inviteState({ ...old, acceptedAt: "2026-11-09T12:00:00Z" }, now)).toBe("accepted");
    expect(inviteState({ ...old, revokedAt: "2026-11-09T12:00:00Z" }, now)).toBe("revoked");
  });

  it("accepts only 64-character lower-case hex tokens", () => {
    expect(isInviteToken("ab".repeat(32))).toBe(true);
    expect(isInviteToken("AB".repeat(32))).toBe(false);
    expect(isInviteToken("ab".repeat(31))).toBe(false);
    expect(isInviteToken(`${"ab".repeat(31)}zz`)).toBe(false);
    expect(isInviteToken(undefined)).toBe(false);
  });
});

describe("routes", () => {
  const token = "cd".repeat(32);

  it("brings an invited manager back to the invite after signing in", () => {
    expect(safeNextPath(teamInvitePath(token))).toBe(`/join/${token}`);
    expect(safeNextPath(`/join/${token}/../../evil`)).toBe("/app");
    expect(safeNextPath("/join/not-a-token")).toBe("/app");
    expect(safeNextPath("//evil.example/join/" + token)).toBe("/app");
  });

  it("keeps worker sessions off the invite page, and lets everyone else open it", () => {
    const path = teamInvitePath(token);
    expect(proxyDecision(path, "", true, true)).toEqual({ type: "redirect", location: "/m" });
    expect(proxyDecision(path, "", true, false)).toEqual({ type: "next" });
    expect(proxyDecision(path, "", false, false)).toEqual({ type: "next" });
  });

  it("opens Settings → Team to owners and admins only", () => {
    expect(canAccessHref("owner", "/app/settings/team")).toBe(true);
    expect(canAccessHref("admin", "/app/settings/team")).toBe(true);
    for (const role of ["hr", "finance", "ops_manager", "line_manager", "worker"] as const) {
      expect(canAccessHref(role, "/app/settings/team")).toBe(false);
    }
  });
});
