import { describe, expect, it } from "vitest";

import { renderEmail } from "@/server/email/render";
import {
  MappingChangedEmail,
  mappingChangedSubject,
} from "@/server/email/templates/mapping-changed";

const APP_URL = "https://ops.metaliratech.com";
const EMOJI = /\p{Extended_Pictographic}/u;

describe("MappingChangedEmail", () => {
  const element = (
    <MappingChangedEmail
      managerName="Tunde Bakare"
      workerName="Musa Ibrahim"
      staffId="MO-0114"
      organisationName="Coastline Facility Services"
      reportsToYou
      changes={[
        "Line manager: Tunde Bakare (was Kola Adebayo)",
        "Site: Lekki Estate Gate B (was Apapa Warehouse 3)",
      ]}
      appliesFrom="17 Nov 2026"
      appUrl={APP_URL}
    />
  );

  it("names the worker, lists the changes and links to People", async () => {
    const { html, text } = await renderEmail(element);
    expect(text).toContain("Hello Tunde Bakare,");
    expect(text).toContain("Musa Ibrahim (MO-0114) now reports to you at Coastline Facility");
    expect(text).toContain("Site: Lekki Estate Gate B (was Apapa Warehouse 3)");
    expect(text).toContain("Site and project changes apply from 17 Nov 2026");
    expect(html).toContain(`href="${APP_URL}/app/people"`);
  });

  it("follows the voice and has a plain subject", async () => {
    const { text } = await renderEmail(element);
    expect(text).not.toMatch(EMOJI);
    expect(text).not.toContain("!");
    expect(mappingChangedSubject("Musa Ibrahim", true)).toBe("Musa Ibrahim now reports to you");
    expect(mappingChangedSubject("Musa Ibrahim", false)).toBe(
      "Musa Ibrahim's work details changed",
    );
  });

  it("greets without a name and leaves out the date when nothing is dated", async () => {
    const { text } = await renderEmail(
      <MappingChangedEmail
        managerName={null}
        workerName="Musa Ibrahim"
        staffId="MO-0114"
        organisationName="Coastline Facility Services"
        reportsToYou={false}
        changes={["Department: Cleaning services (was Security services)"]}
        appliesFrom={null}
        appUrl={APP_URL}
      />,
    );
    expect(text).toContain("Hello,");
    expect(text).toContain("who reports to you at Coastline Facility Services");
    expect(text).not.toContain("apply from");
  });
});
