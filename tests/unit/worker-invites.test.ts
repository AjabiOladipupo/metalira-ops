import { describe, expect, it } from "vitest";

import {
  inviteStatus,
  lagosDate,
  lagosTime,
  plural,
  rosterSummary,
  type RosterWorker,
} from "@/lib/worker-invites";

const NOW = new Date("2026-11-16T09:00:00Z");

function worker(overrides: Partial<RosterWorker> = {}): RosterWorker {
  return {
    id: crypto.randomUUID(),
    staffId: "EMP-0001",
    firstName: "Musa",
    lastName: "Ibrahim",
    hasEmail: false,
    siteId: null,
    siteName: null,
    pinSetAt: null,
    lastSignInAt: null,
    lockedUntil: null,
    openInvite: null,
    ...overrides,
  };
}

describe("inviteStatus", () => {
  it("not invited", () => {
    expect(inviteStatus(worker(), NOW)).toEqual({
      kind: "not_invited",
      label: "Not invited",
      tone: "action",
    });
  });

  it("invited by email or on a printed sheet, until the link expires", () => {
    const open = (sentVia: "email" | "print", expiresAt: string) =>
      worker({ openInvite: { sentVia, createdAt: "2026-11-15T09:00:00Z", expiresAt } });
    expect(inviteStatus(open("email", "2026-11-22T09:00:00Z"), NOW).label).toBe("Invite emailed");
    expect(inviteStatus(open("print", "2026-11-22T09:00:00Z"), NOW)).toMatchObject({
      kind: "invited",
      label: "Invite printed",
      tone: "pending",
    });
    expect(inviteStatus(open("print", "2026-11-16T08:59:59Z"), NOW)).toMatchObject({
      kind: "expired",
      tone: "action",
    });
  });

  it("signed up wins over an open invite (a PIN reset in progress)", () => {
    const w = worker({
      pinSetAt: "2026-11-10T09:00:00Z",
      openInvite: {
        sentVia: "print",
        createdAt: "2026-11-15T09:00:00Z",
        expiresAt: "2026-11-22T09:00:00Z",
      },
    });
    expect(inviteStatus(w, NOW)).toEqual({ kind: "signed_up", label: "Signed up", tone: "done" });
  });

  it("shows a lock in Lagos time until it ends", () => {
    const w = worker({ pinSetAt: "2026-11-10T09:00:00Z", lockedUntil: "2026-11-16T09:12:00Z" });
    expect(inviteStatus(w, NOW)).toEqual({
      kind: "locked",
      label: "Locked until 10:12",
      tone: "action",
    });
    expect(inviteStatus(w, new Date("2026-11-16T09:12:01Z")).kind).toBe("signed_up");
  });
});

describe("rosterSummary", () => {
  it("counts signed up (locked included), invited and the rest", () => {
    const summary = rosterSummary(
      [
        worker({ pinSetAt: "2026-11-10T09:00:00Z" }),
        worker({ pinSetAt: "2026-11-10T09:00:00Z", lockedUntil: "2026-11-16T09:30:00Z" }),
        worker({
          openInvite: {
            sentVia: "email",
            createdAt: "2026-11-15T09:00:00Z",
            expiresAt: "2026-11-22T09:00:00Z",
          },
        }),
        worker({
          openInvite: {
            sentVia: "email",
            createdAt: "2026-11-01T09:00:00Z",
            expiresAt: "2026-11-08T09:00:00Z",
          },
        }),
        worker(),
      ],
      NOW,
    );
    expect(summary).toEqual({ total: 5, signedUp: 2, invited: 1, notInvited: 2 });
  });
});

describe("formatting", () => {
  it("writes dates and times the design-system way, in Lagos time", () => {
    expect(lagosDate("2026-11-21T23:30:00Z")).toBe("22 Nov 2026");
    expect(lagosTime("2026-11-16T17:05:00Z")).toBe("18:05");
    expect(plural(1, "employee")).toBe("1 employee");
    expect(plural(1620, "employee")).toBe("1,620 employees");
  });
});
