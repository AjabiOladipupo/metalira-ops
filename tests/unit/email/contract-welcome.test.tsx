import { describe, expect, it } from "vitest";

import { welcomeRecipients } from "@/server/business/activation";
import { renderEmail } from "@/server/email/render";
import {
  ContractWelcomeEmail,
  contractWelcomeSubject,
} from "@/server/email/templates/contract-welcome";

const APP_URL = "https://ops.metaliratech.com";
const EMOJI = /\p{Extended_Pictographic}/u;

describe("contract welcome email (slice 2.7)", () => {
  it("names the company, contract, sites, go-live date and invoice sender, never bank details", async () => {
    const { text } = await renderEmail(
      <ContractWelcomeEmail
        organisationName="Kola Guarding"
        contactName="Ngozi Eze"
        contractName="Coastline guarding"
        reference="CTR-0001"
        sites={["Apapa Warehouse 3", "Gate B"]}
        goLiveDate="1 Dec 2026"
        invoiceEmail="accounts@kolaguarding.ng"
        appUrl={APP_URL}
      />,
    );
    expect(text).toContain("Hello Ngozi Eze,");
    expect(text).toContain(
      "Kola Guarding has set up Coastline guarding (CTR-0001) and starts work on 1 Dec 2026. It covers 2 sites: Apapa Warehouse 3, Gate B.",
    );
    expect(text).toContain("Invoices will come from accounts@kolaguarding.ng.");
    expect(text).toContain("Payment details appear on each invoice only.");
    expect(text).not.toMatch(/\b\d{10}\b/);
    expect(text).not.toMatch(EMOJI);
    expect(text).not.toContain("!");
    expect(contractWelcomeSubject("Kola Guarding", "1 Dec 2026")).toBe(
      "Kola Guarding: your contract starts on 1 Dec 2026",
    );
  });

  it("falls back to generic wording when names were left out", async () => {
    const { text } = await renderEmail(
      <ContractWelcomeEmail
        organisationName={null}
        contactName={null}
        contractName={null}
        reference="CTR-0002"
        sites={["Lekki Phase 1"]}
        goLiveDate="5 Dec 2026"
        invoiceEmail={null}
        appUrl={APP_URL}
      />,
    );
    expect(text).toContain("Hello,");
    expect(text).toContain(
      "Your service provider has set up contract CTR-0002 and starts work on 5 Dec 2026. It covers Lekki Phase 1.",
    );
    expect(text).not.toContain("Invoices will come from");
    expect(contractWelcomeSubject(null, "5 Dec 2026")).toBe("Your contract starts on 5 Dec 2026");
  });

  it("writes to the primary ops and billing contacts, each address once", () => {
    const contacts = [
      { id: "a", name: "Ngozi", email: "ops@coastline.example", role: "ops", is_primary: true },
      {
        id: "b",
        name: "Bayo",
        email: "accounts@coastline.example",
        role: "billing",
        is_primary: true,
      },
      {
        id: "c",
        name: "Tola",
        email: "other@coastline.example",
        role: "billing",
        is_primary: false,
      },
      {
        id: "d",
        name: "Ada",
        email: "approver@coastline.example",
        role: "approver",
        is_primary: true,
      },
    ];
    expect(welcomeRecipients(contacts).map((r) => r.contactId)).toEqual(["a", "b"]);
    expect(
      welcomeRecipients([
        { id: "a", name: "Ngozi", email: "Same@coastline.example", role: "ops", is_primary: true },
        {
          id: "b",
          name: "Ngozi",
          email: "same@coastline.example",
          role: "billing",
          is_primary: true,
        },
      ]),
    ).toHaveLength(1);
    expect(welcomeRecipients([])).toEqual([]);
  });
});
