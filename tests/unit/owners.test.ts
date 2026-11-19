/**
 * Slice 1.13: owner rules shared by the Team page and the server. The database enforces the
 * same rules (tests/rls/owners.test.ts); these decide which buttons to show and which refusal to
 * explain.
 */
import { describe, expect, it } from "vitest";

import { invitePasswordStep, passwordTrusted, signedInWithEmailLink } from "@/lib/auth/amr";
import { proxyDecision, safeNextPath } from "@/lib/auth/routes";
import {
  describeOwnerChange,
  needsSecondOwner,
  OWNER_DB_MESSAGES,
  ownerChangeChoices,
  ownerChangeRefusal,
} from "@/lib/owners";
import { inviteRefusal, memberRefusal, TEAM_REFUSAL_MESSAGES } from "@/lib/team";

const ownerA = { userId: "u-a", role: "owner" as const };
const ownerB = { userId: "u-b", role: "owner" as const };
const admin = { userId: "u-admin", role: "admin" as const };
const hr = { userId: "u-hr", role: "hr" as const };

describe("needsSecondOwner", () => {
  it("lets one owner add an owner alone", () => {
    expect(needsSecondOwner("add", 1)).toBe(false);
    expect(needsSecondOwner("invite", 1)).toBe(false);
  });

  it("needs a second owner to add one once there are two or more", () => {
    expect(needsSecondOwner("add", 2)).toBe(true);
    expect(needsSecondOwner("invite", 3)).toBe(true);
  });

  it("always needs a second owner to remove or demote one", () => {
    expect(needsSecondOwner("remove", 2)).toBe(true);
    expect(needsSecondOwner("demote", 5)).toBe(true);
  });
});

describe("ownerChangeRefusal", () => {
  it("only owners ask", () => {
    expect(ownerChangeRefusal(admin, "add", hr, 1)).toBe("not_owner");
    expect(ownerChangeRefusal(hr, "invite", null, 1)).toBe("not_owner");
    expect(ownerChangeRefusal(ownerA, "invite", null, 1)).toBeNull();
  });

  it("makes managers owners, never workers or client approvers", () => {
    expect(ownerChangeRefusal(ownerA, "add", hr, 1)).toBeNull();
    expect(ownerChangeRefusal(ownerA, "add", admin, 2)).toBeNull();
    expect(ownerChangeRefusal(ownerA, "add", { userId: "u-w", role: "worker" }, 1)).toBe(
      "not_eligible",
    );
    expect(ownerChangeRefusal(ownerA, "add", { userId: "u-c", role: "client_approver" }, 1)).toBe(
      "not_eligible",
    );
    expect(ownerChangeRefusal(ownerA, "add", ownerB, 2)).toBe("already_owner");
  });

  it("never removes or demotes the last owner", () => {
    expect(ownerChangeRefusal(ownerA, "demote", ownerA, 1)).toBe("last_owner");
    expect(ownerChangeRefusal(ownerA, "demote", ownerA, 2)).toBeNull();
    expect(ownerChangeRefusal(ownerA, "remove", ownerB, 2)).toBeNull();
    expect(ownerChangeRefusal(ownerA, "remove", hr, 2)).toBe("not_an_owner");
  });

  it("never lets an owner remove themselves: they step down instead", () => {
    expect(ownerChangeRefusal(ownerA, "remove", ownerA, 3)).toBe("own_removal");
  });
});

describe("ownerChangeChoices", () => {
  const pending = { requestedBy: ownerA.userId, status: "pending" as const };

  it("a different owner decides; the requester only withdraws", () => {
    expect(ownerChangeChoices(ownerB, pending)).toEqual({ decide: true, withdraw: false });
    expect(ownerChangeChoices(ownerA, pending)).toEqual({ decide: false, withdraw: true });
  });

  it("admins and other managers never decide", () => {
    expect(ownerChangeChoices(admin, pending)).toEqual({ decide: false, withdraw: false });
    expect(ownerChangeChoices(hr, pending)).toEqual({ decide: false, withdraw: false });
  });

  it("nothing to do once decided", () => {
    expect(ownerChangeChoices(ownerB, { ...pending, status: "approved" })).toEqual({
      decide: false,
      withdraw: false,
    });
  });
});

describe("1.12 team rules now say 'an owner'", () => {
  it("any owner grants admin, finance and HR; owners are never changed from the team forms", () => {
    expect(inviteRefusal("owner", "admin")).toBeNull();
    expect(memberRefusal(ownerA, ownerB)).toBe("owner_protected");
    expect(TEAM_REFUSAL_MESSAGES.owner_only).toBe(
      "Only an owner can give, change or remove the admin, finance or HR role.",
    );
    expect(TEAM_REFUSAL_MESSAGES.not_allowed).toBe(
      "Only an owner or an admin can manage the team.",
    );
  });
});

describe("messages", () => {
  it("explains every owner refusal from the database", () => {
    for (const code of ["MLOW1", "MLOW2", "MLOW3", "MLOW4", "MLOW5", "MLOW6", "MLOW7"]) {
      expect(OWNER_DB_MESSAGES[code]).toMatch(/^[A-Z].*\.$/);
    }
  });

  it("describes each change in one sentence", () => {
    const base = {
      targetName: "Hauwa Bello",
      inviteEmail: null,
      newRoleLabel: null,
      requesterName: "Ada Okafor",
      selfDemotion: false,
    };
    expect(describeOwnerChange({ ...base, kind: "add" })).toBe("Make Hauwa Bello an owner");
    expect(describeOwnerChange({ ...base, kind: "remove" })).toBe("Remove Hauwa Bello as an owner");
    expect(
      describeOwnerChange({ ...base, kind: "invite", targetName: null, inviteEmail: "femi@x.ng" }),
    ).toBe("Invite femi@x.ng as an owner");
    expect(
      describeOwnerChange({
        ...base,
        kind: "demote",
        targetName: "Ada Okafor",
        newRoleLabel: "Admin",
        selfDemotion: true,
      }),
    ).toBe("Ada Okafor steps down to Admin");
    expect(describeOwnerChange({ ...base, kind: "demote", newRoleLabel: "HR" })).toBe(
      "Change Hauwa Bello from owner to HR",
    );
    expect(describeOwnerChange({ ...base, kind: "add", targetName: null })).toBe(
      "Make a manager an owner",
    );
  });
});

describe("signedInWithEmailLink", () => {
  it("is true only for an email-link session, and fails closed otherwise", () => {
    expect(signedInWithEmailLink([{ method: "otp", timestamp: 1 }])).toBe(true);
    expect(signedInWithEmailLink([{ method: "magiclink" }])).toBe(true);
    expect(signedInWithEmailLink([{ method: "recovery" }])).toBe(true);
    expect(signedInWithEmailLink([{ method: "password", timestamp: 1 }])).toBe(false);
    expect(signedInWithEmailLink([{ method: "otp" }, { method: "password" }])).toBe(false);
    expect(signedInWithEmailLink([{ method: "oauth" }])).toBe(false);
    expect(signedInWithEmailLink([{ method: "otp" }, { method: "oauth" }])).toBe(false);
    expect(signedInWithEmailLink([])).toBe(false);
    expect(signedInWithEmailLink(undefined)).toBe(false);
    expect(signedInWithEmailLink("otp")).toBe(false);
    expect(signedInWithEmailLink([null, "otp"])).toBe(false);
  });
});

describe("a password counts only once chosen after confirming", () => {
  const confirmedAt = "2026-11-18T10:00:00Z";

  it("passwordTrusted needs password_set_at at or after the confirmation", () => {
    expect(passwordTrusted("2026-11-18T10:00:00Z", confirmedAt)).toBe(true);
    expect(passwordTrusted("2026-11-18T10:05:00Z", confirmedAt)).toBe(true);
    expect(passwordTrusted("2026-11-18T09:59:59Z", confirmedAt)).toBe(false);
    expect(passwordTrusted(undefined, confirmedAt)).toBe(false);
    expect(passwordTrusted("not a date", confirmedAt)).toBe(false);
    expect(passwordTrusted("2026-11-18T10:05:00Z", null)).toBe(false);
  });

  it("an email-link session without a trusted password chooses one", () => {
    expect(invitePasswordStep({ fromEmailLink: true, confirmedAt, passwordSetAt: undefined })).toBe(
      "set_password",
    );
  });

  it("a password session without a trusted password uses an email link, however old", () => {
    expect(
      invitePasswordStep({
        fromEmailLink: false,
        confirmedAt: "2020-01-01T00:00:00Z",
        passwordSetAt: null,
      }),
    ).toBe("use_email_link");
  });

  it("a trusted password is ready, whichever way they signed in", () => {
    const passwordSetAt = "2026-11-18T10:01:00Z";
    expect(invitePasswordStep({ fromEmailLink: false, confirmedAt, passwordSetAt })).toBe("ready");
    expect(invitePasswordStep({ fromEmailLink: true, confirmedAt, passwordSetAt })).toBe("ready");
  });
});

describe("the proxy sends a manager without a trusted password to choose one", () => {
  it("redirects the manager app, never the worker app or a worker", () => {
    expect(proxyDecision("/app/people", "", true, false, true)).toEqual({
      type: "redirect",
      location: "/set-password?next=%2Fapp%2Fpeople",
    });
    expect(proxyDecision("/app", "", true, false, false)).toEqual({ type: "next" });
    expect(proxyDecision("/m", "", true, true, true)).toEqual({ type: "next" });
    expect(proxyDecision("/join/" + "a".repeat(64), "", true, false, true)).toEqual({
      type: "next",
    });
  });

  it("lets an email link come back to /set-password, and nowhere outside the app", () => {
    expect(safeNextPath("/set-password?next=%2Fapp")).toBe("/set-password?next=%2Fapp");
    expect(safeNextPath("//evil.example/set-password")).toBe("/app");
  });
});
