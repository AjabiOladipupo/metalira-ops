/**
 * Slice 1.13: owner-change emails. Every owner change (and request, rejection, withdrawal) emails
 * all owners with a confirmed address, plus a removed or demoted owner. Names and invited
 * addresses that look like web addresses never reach the email; each send has an idempotency key.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderEmail } from "@/server/email/render";
import { OwnerChangeEmail, ownerChangeSubject } from "@/server/email/templates/owner-change";

const sendEmail = vi.fn(async (message: Record<string, unknown>) => ({
  status: "sent" as const,
  type: String(message.subject),
}));
vi.mock("@/server/email/send", () => ({ sendEmail: (m: Record<string, unknown>) => sendEmail(m) }));

vi.setConfig({ testTimeout: 20_000 });

const APP_URL = "https://ops.metaliratech.com";
const EMOJI = /\p{Extended_Pictographic}/u;
const CHANGE = "c0000000-0000-4000-8000-000000000001";
const ORG = "a0000000-0000-4000-8000-000000000001";

beforeEach(() => {
  sendEmail.mockClear();
});

describe("OwnerChangeEmail", () => {
  it("asks the other owners to approve, and follows the voice", async () => {
    const { text, html } = await renderEmail(
      <OwnerChangeEmail
        organisationName="Coastline"
        event="requested"
        summary="Make Hauwa Bello an owner"
        actorName="Ada Okafor"
        singleOwner={false}
        appUrl={APP_URL}
      />,
    );
    expect(text).toContain("Ada Okafor asked: Make Hauwa Bello an owner.");
    expect(text).toContain("A different owner must approve or reject it");
    expect(html).toContain(`href="${APP_URL}/app/settings/team"`);
    expect(text).not.toMatch(EMOJI);
    expect(text).not.toContain("!");
    expect(ownerChangeSubject("Coastline", "requested")).toBe(
      "Owner change waiting for approval at Coastline",
    );
  });

  it("says when one owner decided alone", async () => {
    const { text } = await renderEmail(
      <OwnerChangeEmail
        organisationName={null}
        event="done"
        summary="Make Hauwa Bello an owner"
        actorName={null}
        singleOwner
        appUrl={APP_URL}
      />,
    );
    expect(text).toContain("done by An owner, the only owner at the time");
    expect(text).toContain("At your company");
    expect(ownerChangeSubject(null, "done")).toBe("Owners changed at your company on Metalira Ops");
  });
});

describe("notifyOwnerChange", () => {
  const users: Record<string, { email: string; email_confirmed_at: string | null }> = {
    "u-a": { email: "ada@example.ng", email_confirmed_at: "2026-11-01T00:00:00Z" },
    "u-b": { email: "bola@example.ng", email_confirmed_at: "2026-11-01T00:00:00Z" },
    "u-new": { email: "new@example.ng", email_confirmed_at: null },
    "u-gone": { email: "gone@example.ng", email_confirmed_at: "2026-11-01T00:00:00Z" },
  };
  const names: Record<string, string> = {
    "u-a": "Ada Okafor",
    "u-b": "verify at paypal-secure.co",
    "u-gone": "Gbenga Ade",
  };

  function fakeAdmin(change: Record<string, unknown>) {
    const query = (table: string) => {
      let filterUser: string | null = null;
      const builder: Record<string, unknown> = {};
      Object.assign(builder, {
        select: () => builder,
        eq: (column: string, value: string) => {
          if (column === "user_id") filterUser = value;
          return builder;
        },
        maybeSingle: async () => {
          if (table === "owner_changes") return { data: change, error: null };
          if (table === "organisations") return { data: { name: "Coastline" }, error: null };
          return { data: { full_name: filterUser ? names[filterUser] : null }, error: null };
        },
        then: (resolve: (v: unknown) => void) =>
          resolve({
            data: [{ user_id: "u-a" }, { user_id: "u-b" }, { user_id: "u-new" }],
            error: null,
          }),
      });
      return builder;
    };
    return {
      from: query,
      auth: {
        admin: {
          getUserById: async (id: string) => ({ data: { user: users[id] ?? null } }),
        },
      },
    };
  }

  it("emails every confirmed owner and the removed owner, once each", async () => {
    const { notifyOwnerChange } = await import("@/server/identity/owner-notices");
    const send = vi.fn(async () => ({ status: "sent" as const }));
    const sent = await notifyOwnerChange(CHANGE, "done", "u-b", {
      admin: fakeAdmin({
        id: CHANGE,
        organisation_id: ORG,
        kind: "remove",
        target_user_id: "u-gone",
        invite_email: null,
        new_role: null,
        requested_by: "u-a",
        single_owner: false,
      }) as never,
      send: send as never,
    });
    expect(sent).toBe(3);
    const calls = send.mock.calls as unknown as [Record<string, unknown>][];
    expect(calls.map(([m]) => m.to)).toEqual([
      "ada@example.ng",
      "bola@example.ng",
      "gone@example.ng",
    ]);
    expect(calls[0]![0]).toMatchObject({
      event: "done",
      summary: "Remove Gbenga Ade as an owner",
      organisationName: "Coastline",
      // A name that looks like a web address is left out.
      actorName: null,
      idempotencyKey: `owner-change/${CHANGE}/done/u-a`,
    });
  });

  it("never puts the invited address in the summary", async () => {
    const { notifyOwnerChange } = await import("@/server/identity/owner-notices");
    const send = vi.fn(async () => ({ status: "sent" as const }));
    await notifyOwnerChange(CHANGE, "requested", "u-a", {
      admin: fakeAdmin({
        id: CHANGE,
        organisation_id: ORG,
        kind: "invite",
        target_user_id: null,
        invite_email: "boss@paypal-secure.co",
        new_role: null,
        requested_by: "u-a",
        single_owner: false,
      }) as never,
      send: send as never,
    });
    const calls = send.mock.calls as unknown as [Record<string, unknown>][];
    expect(calls[0]![0].summary).toBe(
      "Invite someone as an owner (check the address in Team settings before approving)",
    );
  });

  it("tells every owner when someone is given admin, finance or HR, and only then", async () => {
    const { notifyOwnerGrantedRole } = await import("@/server/identity/owner-notices");
    const send = vi.fn(async () => ({ status: "sent" as const }));
    const deps = { admin: fakeAdmin({}) as never, send: send as never };
    const sent = await notifyOwnerGrantedRole(ORG, "u-gone", "finance", "u-a", "inv-1", deps);
    expect(sent).toBe(2);
    const calls = send.mock.calls as unknown as [Record<string, unknown>][];
    expect(calls.map((c) => c[0].to)).toEqual(["ada@example.ng", "bola@example.ng"]);
    expect(calls[0]![0]).toMatchObject({
      event: "role_given",
      summary: "Gbenga Ade is now Finance",
      actorName: "Ada Okafor",
      idempotencyKey: "role-given/inv-1/finance/u-a",
    });
    send.mockClear();
    expect(await notifyOwnerGrantedRole(ORG, "u-gone", "line_manager", "u-a", "inv-2", deps)).toBe(
      0,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("keys each notice by change, event and recipient", async () => {
    const { sendOwnerChangeEmail } = await import("@/server/email/team");
    await sendOwnerChangeEmail({
      to: "ada@example.ng",
      idempotencyKey: `owner-change/${CHANGE}/rejected/u-a`,
      organisationName: "Coastline",
      event: "rejected",
      summary: "Make Hauwa Bello an owner",
      actorName: "Bola",
      singleOwner: false,
    });
    expect(sendEmail.mock.calls[0]![0]).toMatchObject({
      idempotencyKey: `owner-change/${CHANGE}/rejected/u-a`,
      subject: "Owner change rejected at Coastline",
    });
  });
});

describe("emailDisplayName", () => {
  it("falls back to generic wording for anything an email would refuse", async () => {
    const { emailDisplayName } = await import("@/server/email/team");
    expect(emailDisplayName("Ada Okafor")).toBe("Ada Okafor");
    expect(emailDisplayName("verify at paypal-secure.co")).toBeNull();
    expect(emailDisplayName("Ada <b>")).toBeNull();
    expect(emailDisplayName("x".repeat(201))).toBeNull();
    expect(emailDisplayName("Ada")).toBeNull();
  });
});
