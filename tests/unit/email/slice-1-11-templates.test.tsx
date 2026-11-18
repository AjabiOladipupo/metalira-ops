/**
 * Slice 1.11 emails: the staff ID correction request (approvers), the staff ID change (the
 * worker, owner decision 18 Nov 2026) and the sign-in pause alert (owner and HR, once per capped
 * window). Values that look like web addresses never reach an email; each send has an
 * idempotency key; addresses are never logged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderEmail } from "@/server/email/render";
import { SignInPausedEmail, signInPausedSubject } from "@/server/email/templates/sign-in-paused";
import {
  StaffIdChangedEmail,
  staffIdChangedSubject,
} from "@/server/email/templates/staff-id-changed";
import {
  StaffIdCorrectionRequestedEmail,
  staffIdCorrectionRequestedSubject,
} from "@/server/email/templates/staff-id-correction-requested";

const sendEmail = vi.fn(async (message: Record<string, unknown>) => ({
  status: "sent" as const,
  type: String(message.subject),
}));
vi.mock("@/server/email/send", () => ({ sendEmail: (m: Record<string, unknown>) => sendEmail(m) }));

vi.setConfig({ testTimeout: 20_000 });

const APP_URL = "https://ops.metaliratech.com";
const EMOJI = /\p{Extended_Pictographic}/u;
const ID = "a0000000-0000-4000-8000-000000000001";
const ID2 = "b0000000-0000-4000-8000-000000000002";

beforeEach(() => {
  sendEmail.mockClear();
});

describe("StaffIdChangedEmail", () => {
  it("tells the worker their new ID and how to sign in", async () => {
    const { text } = await renderEmail(
      <StaffIdChangedEmail
        organisationName="Coastline Facility Services"
        workerName="Musa Ibrahim"
        newStaffId="CFS-0142"
        appUrl={APP_URL}
      />,
    );
    expect(text).toContain("Your new staff ID is CFS-0142");
    expect(text).toContain("Sign in with your company code, your new staff ID and your PIN");
    expect(text).not.toMatch(EMOJI);
    expect(text).not.toContain("!");
    expect(staffIdChangedSubject("Coastline Facility Services")).toBe(
      "Your staff ID at Coastline Facility Services has changed",
    );
  });

  it("points to Me instead of printing an ID that looks like a web address", async () => {
    const { sendStaffIdChangedEmail } = await import("@/server/email/staff-id");
    await sendStaffIdChangedEmail({
      to: "musa@example.ng",
      correctionId: ID,
      organisationName: "acme-pay.com",
      workerName: "Musa Ibrahim",
      newStaffId: "acme-pay.com/verify",
    });
    const message = sendEmail.mock.calls[0]![0];
    expect(message.subject).toBe("Your staff ID has changed");
    const { text, html } = await renderEmail(message.react as React.ReactElement);
    expect(text).not.toContain("acme-pay.com");
    expect(html).not.toContain("acme-pay.com");
    expect(text).toContain("see the new one under Me");
    // One send per correction and address; the address appears only as a hash.
    expect(message.idempotencyKey).toMatch(new RegExp(`^staff-id-changed/${ID}/[0-9a-f]{16}$`));
    expect(String(message.idempotencyKey)).not.toContain("musa@");
  });
});

describe("StaffIdCorrectionRequestedEmail", () => {
  it("names the change and links to the employee", async () => {
    const { text, html } = await renderEmail(
      <StaffIdCorrectionRequestedEmail
        organisationName="Coastline"
        workerName="Musa Ibrahim"
        oldStaffId="CFS-O142"
        newStaffId="CFS-0142"
        requesterName="Hauwa Bello"
        reviewUrl={`${APP_URL}/app/people/${ID}#contact`}
        appUrl={APP_URL}
      />,
    );
    expect(text).toContain(
      "Hauwa Bello asked to change the staff ID of Musa Ibrahim from CFS-O142 to CFS-0142",
    );
    expect(html).toContain(`href="${APP_URL}/app/people/${ID}#contact"`);
    expect(staffIdCorrectionRequestedSubject(null)).toBe(
      "A staff ID correction needs your approval",
    );
  });

  it("drops domain-like names and IDs", async () => {
    const { sendStaffIdCorrectionRequestedEmail } = await import("@/server/email/staff-id");
    await sendStaffIdCorrectionRequestedEmail({
      to: "owner@example.ng",
      correctionId: ID,
      workerId: ID2,
      recipientId: ID2,
      organisationName: "Coastline",
      workerName: "verify-now.com",
      requesterName: "Hauwa Bello",
      oldStaffId: "CFS-0001",
      newStaffId: "pay.example.com/x",
    });
    const message = sendEmail.mock.calls[0]![0];
    const { text } = await renderEmail(message.react as React.ReactElement);
    expect(text).not.toContain("verify-now.com");
    expect(text).not.toContain("pay.example.com");
    expect(text).toContain("asked to change the staff ID of an employee.");
    expect(message.idempotencyKey).toBe(`staff-id-correction-requested/${ID}/${ID2}`);
  });
});

describe("SignInPausedEmail", () => {
  it("says how long sign-ins are paused, that signed-in workers are fine, and nobody was locked out", async () => {
    const { text } = await renderEmail(
      <SignInPausedEmail
        organisationName="Coastline"
        cap={50}
        minutes={15}
        until="18 Nov 2026, 09:15"
        appUrl={APP_URL}
      />,
    );
    expect(text).toContain("Someone typed 50 wrong PINs");
    expect(text).toContain("paused until 18 Nov 2026, 09:15");
    expect(text).toContain("Workers who are already signed in on their phones are not affected");
    expect(text).toContain("Nobody was locked out by this pause");
    expect(text).not.toMatch(EMOJI);
    expect(text).not.toContain("!");
    expect(signInPausedSubject("Coastline")).toBe(
      "Phone sign-ins paused at Coastline after many wrong PINs",
    );
  });
});

describe("notifyCompanyThrottled", () => {
  function fakeAdmin(options: { alert: { id: string; after: unknown } | null }) {
    const users: Record<string, { email: string; email_confirmed_at: string | null }> = {
      "u-owner": { email: "owner@example.ng", email_confirmed_at: "2026-11-01T00:00:00Z" },
      "u-hr": { email: "hr@example.ng", email_confirmed_at: "2026-11-01T00:00:00Z" },
      "u-hr-unconfirmed": { email: "new@example.ng", email_confirmed_at: null },
    };
    const query = (table: string) => {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: chain,
        eq: chain,
        gte: chain,
        order: chain,
        limit: chain,
        in: async () => ({
          data: [{ user_id: "u-owner" }, { user_id: "u-hr" }, { user_id: "u-hr-unconfirmed" }],
          error: null,
        }),
        maybeSingle: async () =>
          table === "audit_log"
            ? { data: options.alert, error: null }
            : { data: { name: "Coastline" }, error: null },
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

  it("emails each confirmed owner and HR user once, keyed by the window's audit row", async () => {
    const { notifyCompanyThrottled } = await import("@/server/identity/sign-in-alerts");
    const send = vi.fn(async () => ({ status: "sent" as const }));
    const alert = { id: ID, after: { until: "2026-11-18T08:15:00Z", wrong_pin_cap: 50 } };
    const sent = await notifyCompanyThrottled(ID2, {
      admin: fakeAdmin({ alert }) as never,
      send: send as never,
    });
    expect(sent).toBe(2);
    const calls = send.mock.calls as unknown as [Record<string, unknown>][];
    expect(calls.map(([m]) => m.to)).toEqual(["owner@example.ng", "hr@example.ng"]);
    expect(calls.map(([m]) => m.alertId)).toEqual([ID, ID]);
    expect(calls[0]![0]).toMatchObject({ cap: 50, minutes: 15, organisationName: "Coastline" });
  });

  it("sends nothing when no window was capped", async () => {
    const { notifyCompanyThrottled } = await import("@/server/identity/sign-in-alerts");
    const send = vi.fn();
    expect(
      await notifyCompanyThrottled(ID2, { admin: fakeAdmin({ alert: null }) as never, send }),
    ).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("one key per window and recipient, so a retry never sends twice", async () => {
    const { sendSignInPausedEmail } = await import("@/server/email/staff-id");
    await sendSignInPausedEmail({
      to: "owner@example.ng",
      alertId: ID,
      recipientId: ID2,
      organisationName: "Coastline",
      cap: 50,
      minutes: 15,
      until: "18 Nov 2026, 09:15",
    });
    expect(sendEmail.mock.calls[0]![0].idempotencyKey).toBe(`sign-in-paused/${ID}/${ID2}`);
  });
});
