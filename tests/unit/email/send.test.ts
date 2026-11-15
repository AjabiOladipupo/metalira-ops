import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const resend = vi.hoisted(() => ({
  keys: [] as string[],
  send: vi.fn(),
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: resend.send };
    constructor(key: string) {
      resend.keys.push(key);
    }
  },
}));

const { EmailConfigError, EmailSendError, maskEmail, sendEmail } =
  await import("@/server/email/send");
const { sendWelcomeOwnerEmail } = await import("@/server/email");
const { TestEmail } = await import("@/server/email/templates/test-email");

const ORG_ID = "6f1c2a9e-4b7d-4c1e-9a3b-2d5e8f0a1b2c";

function testInput(overrides: Record<string, unknown> = {}) {
  return {
    to: "ada@example.com",
    subject: "Test email from Metalira Ops",
    react: createElement(TestEmail, {
      appUrl: "https://ops.metaliratech.com",
      sentAt: new Date("2026-11-15T13:05:00Z"),
    }),
    ...overrides,
  };
}

beforeEach(() => {
  resend.send.mockReset();
  resend.keys.length = 0;
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("EMAIL_FROM", "");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sendEmail without an API key", () => {
  it("skips with a masked log line outside production", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await sendEmail(testInput());

    expect(result).toEqual({ status: "skipped", reason: "no_api_key" });
    expect(resend.send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("a***@example.com");
    expect(line).not.toContain("ada@example.com");
    expect(line).not.toContain("Email is working");
  });

  it("skips on a Vercel preview", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(sendEmail(testInput())).resolves.toMatchObject({ status: "skipped" });
  });

  it("throws in Vercel production", async () => {
    vi.stubEnv("VERCEL_ENV", "production");

    await expect(sendEmail(testInput())).rejects.toBeInstanceOf(EmailConfigError);
    expect(resend.send).not.toHaveBeenCalled();
  });

  it("throws in a production build outside Vercel", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await expect(sendEmail(testInput())).rejects.toBeInstanceOf(EmailConfigError);
  });
});

describe("sendEmail with an API key", () => {
  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
  });

  it("sends rendered HTML and plain text from the default sender", async () => {
    resend.send.mockResolvedValue({ data: { id: "email_123" }, error: null, headers: null });

    const result = await sendEmail(
      testInput({ tags: [{ name: "type", value: "test" }], idempotencyKey: "test/1" }),
    );

    expect(result).toEqual({ status: "sent", id: "email_123" });
    expect(resend.keys).toContain("re_test_key");
    expect(resend.send).toHaveBeenCalledTimes(1);
    const [payload, options] = resend.send.mock.calls[0] ?? [];
    expect(payload).toMatchObject({
      from: "Metalira Ops <no-reply@ops.metaliratech.com>",
      to: "ada@example.com",
      subject: "Test email from Metalira Ops",
      tags: [{ name: "type", value: "test" }],
    });
    expect(payload.html).toContain("Email is working");
    expect(payload.text).toContain("Email is working");
    expect(payload.text).not.toContain("<");
    expect(payload).not.toHaveProperty("react");
    expect(options).toEqual({ idempotencyKey: "test/1" });
  });

  it("uses EMAIL_FROM and a caller's plain text when given", async () => {
    vi.stubEnv("EMAIL_FROM", "Ops <ops@example.com>");
    resend.send.mockResolvedValue({ data: { id: "email_456" }, error: null, headers: null });

    await sendEmail(testInput({ text: "Plain version", replyTo: "help@example.com" }));

    const [payload, options] = resend.send.mock.calls[0] ?? [];
    expect(payload).toMatchObject({
      from: "Ops <ops@example.com>",
      text: "Plain version",
      replyTo: "help@example.com",
    });
    expect(options).toBeUndefined();
  });

  it("throws EmailSendError when Resend returns an error", async () => {
    resend.send.mockResolvedValue({
      data: null,
      error: { name: "validation_error", message: "Invalid from field", statusCode: 422 },
      headers: null,
    });

    const failure = sendEmail(testInput());

    await expect(failure).rejects.toBeInstanceOf(EmailSendError);
    await expect(failure).rejects.toMatchObject({ code: "validation_error", statusCode: 422 });
    await expect(failure).rejects.not.toThrow(/ada@example\.com/);
  });
});

describe("sendEmail input validation", () => {
  it.each([
    ["an invalid address", { to: "not-an-email" }],
    ["an empty subject", { subject: "   " }],
    ["a subject over 200 characters", { subject: "a".repeat(201) }],
    ["a non-element body", { react: "<p>hi</p>" }],
    ["a tag with spaces", { tags: [{ name: "type", value: "welcome owner" }] }],
  ])("rejects %s before any send", async (_label, overrides) => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");

    await expect(sendEmail(testInput(overrides))).rejects.toThrow();
    expect(resend.send).not.toHaveBeenCalled();
  });
});

describe("sendWelcomeOwnerEmail", () => {
  it("sends once per organisation with a welcome tag", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://preview.example.com/");
    resend.send.mockResolvedValue({ data: { id: "email_789" }, error: null, headers: null });

    const result = await sendWelcomeOwnerEmail({
      to: "ada@example.com",
      ownerName: "Ada Okafor",
      organisationName: "Coastline Facility Services",
      organisationId: ORG_ID,
    });

    expect(result).toEqual({ status: "sent", id: "email_789" });
    const [payload, options] = resend.send.mock.calls[0] ?? [];
    expect(payload.subject).toBe("Coastline Facility Services is set up on Metalira Ops");
    expect(payload.tags).toEqual([{ name: "type", value: "welcome_owner" }]);
    expect(payload.html).toContain("https://preview.example.com/app");
    expect(payload.html).toContain("https://preview.example.com/brand/ops-logo.png");
    expect(options).toEqual({ idempotencyKey: `welcome-owner/${ORG_ID}` });
  });

  it("rejects a missing organisation id", async () => {
    await expect(
      sendWelcomeOwnerEmail({
        to: "ada@example.com",
        ownerName: "Ada Okafor",
        organisationName: "Coastline Facility Services",
        organisationId: "not-a-uuid",
      }),
    ).rejects.toThrow();
  });
});

describe("maskEmail", () => {
  it.each([
    ["ada@example.com", "a***@example.com"],
    ["a@b.co", "a***@b.co"],
    ["no-at-sign", "***"],
    ["@example.com", "***"],
  ])("masks %s as %s", (input, expected) => {
    expect(maskEmail(input)).toBe(expected);
  });
});
