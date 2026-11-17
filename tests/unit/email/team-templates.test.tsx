import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderEmail } from "@/server/email/render";
import { TeamInviteEmail, teamInviteSubject } from "@/server/email/templates/team-invite";
import { TeamRemovedEmail, teamRemovedSubject } from "@/server/email/templates/team-removed";
import {
  TeamRoleChangedEmail,
  teamRoleChangedSubject,
} from "@/server/email/templates/team-role-changed";

// Rendering and the first import of the email module are slow on a busy machine.
vi.setConfig({ testTimeout: 20_000 });

const APP_URL = "https://ops.metaliratech.com";
const INVITE = `${APP_URL}/join/${"ab".repeat(32)}`;
const EMOJI = /\p{Extended_Pictographic}/u;

describe("TeamInviteEmail", () => {
  const element = (
    <TeamInviteEmail
      organisationName="Coastline Facility Services"
      inviterName="Ada Okafor"
      roleLabel="HR"
      email="hauwa@coastline.ng"
      inviteUrl={INVITE}
      expiresOn="24 Nov 2026"
      appUrl={APP_URL}
    />
  );

  it("names the company, role and address, and links to the invite", async () => {
    const { html, text } = await renderEmail(element);
    expect(text).toContain("Ada Okafor invited you to join Coastline Facility Services");
    expect(text).toContain("as HR");
    expect(text).toContain("Sign in or create an account with hauwa@coastline.ng");
    expect(text).toContain("until 24 Nov 2026");
    expect(html).toContain(`href="${INVITE}"`);
  });

  it("follows the voice", async () => {
    const { text } = await renderEmail(element);
    expect(text).not.toMatch(EMOJI);
    expect(text).not.toContain("!");
    expect(teamInviteSubject("Coastline Facility Services")).toBe(
      "Join Coastline Facility Services on Metalira Ops",
    );
  });

  it("still reads well without an inviter name", async () => {
    const { text } = await renderEmail(
      <TeamInviteEmail
        organisationName="Coastline"
        inviterName={null}
        roleLabel="Finance"
        email="femi@coastline.ng"
        inviteUrl={INVITE}
        expiresOn="24 Nov 2026"
        appUrl={APP_URL}
      />,
    );
    expect(text).toContain("Someone at Coastline invited you to join Coastline");
  });
});

describe("role changed and removed notices", () => {
  it("tells the member their old and new role", async () => {
    const { text } = await renderEmail(
      <TeamRoleChangedEmail
        organisationName="Coastline"
        memberName="Hauwa Bello"
        oldRoleLabel="HR"
        newRoleLabel="Finance"
        changedBy="Ada Okafor"
        appUrl={APP_URL}
      />,
    );
    expect(text).toContain("Hello Hauwa Bello,");
    expect(text).toContain("Ada Okafor changed your role at Coastline from HR to Finance");
    expect(text).not.toContain("!");
    expect(teamRoleChangedSubject("Coastline", "Finance")).toBe(
      "Your role at Coastline is now Finance",
    );
  });

  it("tells a removed member, without touching their other companies", async () => {
    const { text } = await renderEmail(
      <TeamRemovedEmail
        organisationName="Coastline"
        memberName={null}
        removedBy={null}
        appUrl={APP_URL}
      />,
    );
    expect(text).toContain("Hello,");
    expect(text).toContain("An admin at Coastline removed you from Coastline");
    expect(text).toContain("any other companies you belong to are not affected");
    expect(text).not.toMatch(EMOJI);
    expect(teamRemovedSubject("Coastline")).toBe(
      "You no longer have access to Coastline on Metalira Ops",
    );
  });
});

describe("team senders", () => {
  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("VERCEL_ENV", "preview");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("skip without a Resend key and log the address masked", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendTeamInviteEmail } = await import("@/server/email/team");
    const result = await sendTeamInviteEmail({
      to: "hauwa@coastline.ng",
      inviteId: "00000000-0000-4000-8000-000000000001",
      organisationName: "Coastline",
      inviterName: "Ada Okafor",
      roleLabel: "HR",
      inviteUrl: INVITE,
      expiresAt: new Date("2026-11-24T12:00:00Z"),
    });
    expect(result).toEqual({ status: "skipped", reason: "no_api_key" });
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("type=team_invite");
    expect(logged).not.toContain("hauwa@coastline.ng");
  });

  it("leave a company or person name that looks like a web address out of the email", async () => {
    const { emailDisplayName } = await import("@/server/email/team");
    expect(emailDisplayName("Coastline Facility Services")).toBe("Coastline Facility Services");
    expect(emailDisplayName("St. Mary Cleaning Ltd.")).toBe("St. Mary Cleaning Ltd.");
    expect(emailDisplayName("Verify at paypal-secure.co")).toBeNull();
    expect(emailDisplayName("acme.ng")).toBeNull();
    expect(emailDisplayName(null)).toBeNull();

    expect(teamInviteSubject(null)).toBe("You are invited to join a team on Metalira Ops");
    const { text } = await renderEmail(
      <TeamInviteEmail
        organisationName={null}
        inviterName={null}
        roleLabel="HR"
        email="hauwa@coastline.ng"
        inviteUrl={INVITE}
        expiresOn="24 Nov 2026"
        appUrl={APP_URL}
      />,
    );
    expect(text).toContain("A manager invited you to join their company on Metalira Ops as HR");
    expect(teamRemovedSubject(null)).toBe("You no longer have access to a company on Metalira Ops");
    expect(teamRoleChangedSubject(null, "HR")).toBe("Your role on Metalira Ops is now HR");
  });

  it("refuse a name with a web address", async () => {
    const { sendTeamRemovedEmail } = await import("@/server/email/team");
    await expect(
      sendTeamRemovedEmail({
        to: "hauwa@coastline.ng",
        membershipId: "00000000-0000-4000-8000-000000000002",
        organisationName: "Pay now at www.evil.example",
        memberName: null,
        removedBy: null,
      }),
    ).rejects.toThrow();
  });
});
