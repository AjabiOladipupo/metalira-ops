import { describe, expect, it } from "vitest";

import { renderEmail } from "@/server/email/render";
import {
  PayrollDecidedEmail,
  payrollDecidedSubject,
  type PayrollDecision,
} from "@/server/email/templates/payroll-decided";

const APP_URL = "https://ops.metaliratech.com";
const EMOJI = /\p{Extended_Pictographic}/u;
const RUN = "a0000000-0000-4000-8000-000000000001";

const element = (decision: PayrollDecision) => (
  <PayrollDecidedEmail
    decision={decision}
    organisationName="Coastline Security"
    period="20 Sep to 19 Oct 2026"
    payDate="25 Oct 2026"
    workers={6}
    deciderName="Adaeze Okafor"
    runUrl={`${APP_URL}/app/payroll/${RUN}`}
    appUrl={APP_URL}
  />
);

describe("PayrollDecidedEmail (slice 5.3)", () => {
  it("tells the preparer the run was approved and posted, with a link", async () => {
    const { html, text } = await renderEmail(element("approved"));
    expect(text).toContain("Adaeze Okafor approved payroll for 20 Sep to 19 Oct 2026");
    expect(text).toContain("6 workers");
    expect(text).toContain("25 Oct 2026");
    expect(text).toContain("The payslips are posted");
    expect(html).toContain(`href="${APP_URL}/app/payroll/${RUN}"`);
    expect(payrollDecidedSubject("approved", "20 Sep to 19 Oct 2026")).toBe(
      "Payroll for 20 Sep to 19 Oct 2026 is approved",
    );
  });

  it("tells the preparer the run came back, pointing at the reason in the app", async () => {
    const { text } = await renderEmail(element("returned"));
    expect(text).toContain("Adaeze Okafor returned payroll for 20 Sep to 19 Oct 2026 to you");
    expect(text).toContain("Open the run to read the reason");
    expect(payrollDecidedSubject("returned", "20 Sep to 19 Oct 2026")).toBe(
      "Payroll for 20 Sep to 19 Oct 2026 was returned to you",
    );
  });

  it("carries no amounts and follows the voice", async () => {
    for (const decision of ["approved", "returned"] as const) {
      const { text } = await renderEmail(element(decision));
      expect(text).not.toMatch(/₦|NGN|\bkobo\b/i);
      expect(text).not.toMatch(EMOJI);
      expect(text).not.toContain("!");
    }
  });
});
