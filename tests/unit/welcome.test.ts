import type { User } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendWelcomeOwnerEmail = vi.fn();
vi.mock("@/server/email", () => ({ sendWelcomeOwnerEmail }));

const { sendOwnerWelcome } = await import("@/server/identity/welcome");

const org = {
  organisationId: "a0000000-0000-4000-8000-000000000001",
  organisationName: "Alpha Guards",
};

function user(patch: Partial<User> = {}): User {
  return {
    id: "u1",
    email: "ada@alpha.example",
    email_confirmed_at: "2026-11-16T00:00:00Z",
    app_metadata: {},
    user_metadata: {},
    aud: "authenticated",
    created_at: "2026-11-16T00:00:00Z",
    ...patch,
  } as User;
}

beforeEach(() => {
  sendWelcomeOwnerEmail.mockReset();
  sendWelcomeOwnerEmail.mockResolvedValue({ status: "sent", id: "e1" });
});

describe("sendOwnerWelcome", () => {
  it("sends to the confirmed address of the signed-in owner, once per organisation", async () => {
    await sendOwnerWelcome(user(), org, "Ada Okafor");
    expect(sendWelcomeOwnerEmail).toHaveBeenCalledWith({
      to: "ada@alpha.example",
      ownerName: "Ada Okafor",
      organisationName: "Alpha Guards",
      organisationId: org.organisationId,
    });
  });

  it("falls back to the address's name part when there is no full name", async () => {
    await sendOwnerWelcome(user(), org, "  ");
    expect(sendWelcomeOwnerEmail).toHaveBeenCalledWith(
      expect.objectContaining({ ownerName: "ada" }),
    );
  });

  it("sends nothing for an unconfirmed address", async () => {
    await sendOwnerWelcome(user({ email_confirmed_at: undefined }), org, "Ada Okafor");
    expect(sendWelcomeOwnerEmail).not.toHaveBeenCalled();
  });

  it("logs a failed send instead of throwing after the response", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    sendWelcomeOwnerEmail.mockRejectedValue(new Error("Resend is down"));
    await expect(sendOwnerWelcome(user(), org, "Ada Okafor")).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(org.organisationId),
      "Error: Resend is down",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("ada@alpha.example");
    log.mockRestore();
  });
});
