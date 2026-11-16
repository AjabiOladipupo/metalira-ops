import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderEmail } from "@/server/email/render";
import { WorkerInviteEmail, workerInviteSubject } from "@/server/email/templates/worker-invite";

// Rendering and the first import of the email module are slow on a busy machine.
vi.setConfig({ testTimeout: 20_000 });

const APP_URL = "https://ops.metaliratech.com";
const INVITE = `${APP_URL}/m/invite/${"ab".repeat(32)}`;
const EMOJI = /\p{Extended_Pictographic}/u;

const element = (
  <WorkerInviteEmail
    firstName="Musa"
    organisationName="Coastline Facility Services"
    companyCode="K7PQ2M"
    staffId="EMP-0114"
    inviteUrl={INVITE}
    expiresOn="23 Nov 2026"
    appUrl={APP_URL}
  />
);

describe("WorkerInviteEmail", () => {
  it("links to the invite and gives the sign-in details", async () => {
    const { html, text } = await renderEmail(element);
    expect(text).toContain("Hello Musa,");
    expect(text).toContain("Coastline Facility Services uses Metalira Ops");
    expect(html).toContain(`href="${INVITE}"`);
    expect(text).toContain("company code K7PQ2M");
    expect(text).toContain("staff ID EMP-0114");
    expect(text).toContain("until 23 Nov 2026");
  });

  it("follows the voice and never asks for the PIN by email", async () => {
    const { text } = await renderEmail(element);
    expect(text).not.toMatch(EMOJI);
    expect(text).not.toContain("!");
    expect(text).not.toMatch(/reply with/i);
    expect(workerInviteSubject("Coastline Facility Services")).toBe(
      "Set your PIN for Coastline Facility Services on Metalira Ops",
    );
  });
});

describe("sendWorkerInviteEmail", () => {
  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const base = {
    to: "musa@example.test",
    firstName: "Musa",
    organisationName: "Coastline Facility Services",
    companyCode: "K7PQ2M",
    staffId: "EMP-0114",
    inviteUrl: INVITE,
    expiresAt: new Date("2026-11-23T08:00:00Z"),
    inviteId: crypto.randomUUID(),
  };

  it("skips without a Resend key outside production, logging no address in full", async () => {
    const { sendWorkerInviteEmail } = await import("@/server/email");
    await expect(sendWorkerInviteEmail(base)).resolves.toEqual({
      status: "skipped",
      reason: "no_api_key",
    });
    const logged = vi.mocked(console.warn).mock.calls.flat().join(" ");
    expect(logged).toContain("type=worker_invite");
    expect(logged).not.toContain("musa@example.test");
  });

  it.each([
    ["a name with a web address", { firstName: "www.evil.example" }],
    ["a company name with angle brackets", { organisationName: "<b>Evil</b>" }],
    ["a malformed company code", { companyCode: "k7pq2m" }],
    ["a link that is not http(s)", { inviteUrl: "javascript:alert(1)" }],
  ])("refuses %s", async (_label, change) => {
    const { sendWorkerInviteEmail } = await import("@/server/email");
    await expect(sendWorkerInviteEmail({ ...base, ...change })).rejects.toThrow();
  });
});
