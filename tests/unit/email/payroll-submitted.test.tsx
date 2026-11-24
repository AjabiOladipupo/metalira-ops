import { describe, expect, it } from "vitest";

import { renderEmail } from "@/server/email/render";
import {
  PayrollSubmittedEmail,
  payrollSubmittedSubject,
} from "@/server/email/templates/payroll-submitted";

const APP_URL = "https://ops.metaliratech.com";
const EMOJI = /\p{Extended_Pictographic}/u;
const RUN = "a0000000-0000-4000-8000-000000000001";

describe("PayrollSubmittedEmail (slice 5.2)", () => {
  const element = (
    <PayrollSubmittedEmail
      organisationName="Coastline Security"
      period="20 Sep to 19 Oct 2026"
      payDate="25 Oct 2026"
      workers={6}
      preparerName="Oluwaseun Adeyemi"
      runUrl={`${APP_URL}/app/payroll/${RUN}`}
      appUrl={APP_URL}
    />
  );

  it("names the period, the pay date, the count and who prepared it, and links to the run", async () => {
    const { html, text } = await renderEmail(element);
    expect(text).toContain("Oluwaseun Adeyemi submitted payroll for 20 Sep to 19 Oct 2026");
    expect(text).toContain("6 workers");
    expect(text).toContain("25 Oct 2026");
    expect(text).toContain("A different person from the one who prepared it must approve");
    expect(html).toContain(`href="${APP_URL}/app/payroll/${RUN}"`);
  });

  it("carries no amounts and follows the voice", async () => {
    const { text } = await renderEmail(element);
    expect(text).not.toMatch(/₦|NGN|\bkobo\b/i);
    expect(text).not.toMatch(EMOJI);
    expect(text).not.toContain("!");
    expect(payrollSubmittedSubject("20 Sep to 19 Oct 2026")).toBe(
      "Payroll for 20 Sep to 19 Oct 2026 is waiting for your approval",
    );
  });
});
