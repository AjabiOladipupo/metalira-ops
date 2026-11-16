import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderEmail } from "@/server/email/render";
import { emailColors } from "@/server/email/tokens";
import { TestEmail, testEmailSubject } from "@/server/email/templates/test-email";
import { WelcomeOwnerEmail, welcomeOwnerSubject } from "@/server/email/templates/welcome-owner";

const APP_URL = "https://ops.metaliratech.com";
const EMOJI = /\p{Extended_Pictographic}/u;

describe("WelcomeOwnerEmail", () => {
  const element = (
    <WelcomeOwnerEmail
      ownerName="Ada Okafor"
      organisationName="Coastline Facility Services"
      appUrl={APP_URL}
    />
  );

  it("names the owner and the organisation and links to the app", async () => {
    const { html, text } = await renderEmail(element);

    expect(text).toContain("Your company is set up");
    expect(text).toContain("Hello Ada Okafor,");
    expect(text).toContain("Coastline Facility Services now has a Metalira Ops account");
    expect(html).toContain(`href="${APP_URL}/app"`);
    expect(text).toContain("Open Metalira Ops");
  });

  it("uses the absolute PNG logo, never an SVG", async () => {
    const { html } = await renderEmail(element);

    expect(html).toContain(`src="${APP_URL}/brand/ops-logo.png"`);
    expect(html).toContain('alt="Metalira Ops"');
    expect(html).not.toMatch(/\.svg/i);
  });

  it("follows the voice: no emoji, no exclamation marks", async () => {
    const { text } = await renderEmail(element);

    expect(text).not.toMatch(EMOJI);
    expect(text).not.toContain("!");
    expect(welcomeOwnerSubject("Coastline Facility Services")).toBe(
      "Coastline Facility Services is set up on Metalira Ops",
    );
  });

  it("keeps the signal colour for links only", async () => {
    const { html } = await renderEmail(element);
    const signalUses = html.match(new RegExp(emailColors.signal, "gi")) ?? [];
    const links = html.match(/<a\b[^>]*color:\s*#6D4CFF/gi) ?? [];

    expect(signalUses.length).toBeGreaterThan(0);
    expect(signalUses.length).toBe(links.length);
  });

  it("escapes user-supplied names", async () => {
    const { html } = await renderEmail(
      <WelcomeOwnerEmail
        ownerName="<script>alert(1)</script>"
        organisationName="Ade & Sons"
        appUrl={APP_URL}
      />,
    );

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Ade &amp; Sons");
  });

  it("has a non-empty plain-text version with the footer", async () => {
    const { text } = await renderEmail(element);

    expect(text.startsWith("Your company is set up")).toBe(true);
    expect(text.length).toBeGreaterThan(100);
    expect(text).toContain("Meta Lira Technology LTD");
    expect(text).toContain("You received this email because");
  });
});

describe("TestEmail", () => {
  it("renders the check line in Lagos time", async () => {
    const { html, text } = await renderEmail(
      <TestEmail appUrl={APP_URL} sentAt={new Date("2026-11-15T13:05:00Z")} />,
    );

    expect(testEmailSubject).toBe("Test email from Metalira Ops");
    expect(text).toContain("Email is working");
    expect(text).toContain("15 Nov 2026, 14:05 Lagos time");
    expect(html).toContain(`src="${APP_URL}/brand/ops-logo.png"`);
    expect(text).not.toMatch(EMOJI);
    expect(text).not.toContain("!");
  });
});

describe("email tokens", () => {
  it("match the light column of docs/DESIGN_SYSTEM.md", () => {
    const md = readFileSync(join(process.cwd(), "docs/DESIGN_SYSTEM.md"), "utf8");
    const light = new Map<string, string>();
    for (const match of md.matchAll(/^\|\s*([a-z-]+)\s*\|\s*(#[0-9A-F]{6})\s*\|/gim)) {
      light.set(match[1]!, match[2]!.toUpperCase());
    }

    expect(Object.fromEntries(light)).toEqual({
      bg: emailColors.bg,
      surface: emailColors.surface,
      line: emailColors.line,
      fg: emailColors.fg,
      "fg-muted": emailColors.fgMuted,
      signal: emailColors.signal,
    });
  });
});
