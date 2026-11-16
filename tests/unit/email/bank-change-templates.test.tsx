import { describe, expect, it } from "vitest";

import { renderEmail } from "@/server/email/render";
import {
  BankChangeAppliedEmail,
  bankChangeAppliedSubject,
} from "@/server/email/templates/bank-change-applied";
import {
  BankChangeApprovedEmail,
  bankChangeApprovedSubject,
} from "@/server/email/templates/bank-change-approved";
import {
  BankChangeRequestedEmail,
  bankChangeRequestedSubject,
} from "@/server/email/templates/bank-change-requested";

const APP_URL = "https://ops.metaliratech.com";
const EMOJI = /\p{Extended_Pictographic}/u;

function voice(text: string) {
  expect(text).not.toMatch(EMOJI);
  expect(text).not.toContain("!");
}

describe("bank-change emails", () => {
  it("asks an approver to review, naming the worker and the last four digits only", async () => {
    const { html, text } = await renderEmail(
      <BankChangeRequestedEmail
        organisationName="Coastline Facility Services"
        workerName="Musa Ibrahim"
        staffId="MO-0114"
        requesterName="Hauwa Bello"
        last4="7712"
        appUrl={APP_URL}
      />,
    );
    expect(text).toContain(
      "Hauwa Bello asked to change the bank details of Musa Ibrahim (MO-0114) to an account ending 7712.",
    );
    expect(text).toContain("72 hours");
    expect(html).toContain(`href="${APP_URL}/app/people/approvals"`);
    expect(bankChangeRequestedSubject("Musa Ibrahim")).toBe(
      "Bank change for Musa Ibrahim needs your approval",
    );
    voice(text);
  });

  it("says when the worker raised it from their phone", async () => {
    const { text } = await renderEmail(
      <BankChangeRequestedEmail
        organisationName="Coastline"
        workerName="Musa Ibrahim"
        staffId="MO-0114"
        requesterName={null}
        last4="7712"
        appUrl={APP_URL}
      />,
    );
    expect(text).toContain("Musa Ibrahim (from their own phone) asked");
  });

  it("tells the worker when the change takes effect and how to stop it", async () => {
    const { text } = await renderEmail(
      <BankChangeApprovedEmail
        organisationName="Coastline"
        workerName="Musa Ibrahim"
        last4="7712"
        appliesAt="19 Nov 2026, 14:05"
        appUrl={APP_URL}
      />,
    );
    expect(text).toContain("the account ending 7712");
    expect(text).toContain("takes effect on 19 Nov 2026, 14:05 Lagos time");
    expect(text).toContain("Until then your pay goes to your current account.");
    expect(text).toContain("If you did not ask for this change, tell HR");
    expect(bankChangeApprovedSubject("Coastline")).toBe(
      "Your new bank account with Coastline is approved",
    );
    voice(text);
  });

  it("tells the worker when the new account is in use", async () => {
    const { text } = await renderEmail(
      <BankChangeAppliedEmail
        organisationName="Coastline"
        workerName="Musa Ibrahim"
        last4="7712"
        appliedAt="19 Nov 2026, 14:05"
        appUrl={APP_URL}
      />,
    );
    expect(text).toContain(
      "From 19 Nov 2026, 14:05 Lagos time, Coastline pays you into the account ending 7712.",
    );
    expect(bankChangeAppliedSubject("7712")).toBe("Your pay now goes to the account ending 7712");
    voice(text);
  });
});
