import { describe, expect, it } from "vitest";

import {
  filterClients,
  summariseClients,
  clientNeedsDetails,
  type ClientRow,
} from "@/server/business/clients-data";
import {
  addContactSchema,
  createClientSchema,
  quickAddClientSchema,
  updateClientSchema,
  updateContactSchema,
} from "@/server/business/schemas";

const CLIENT = "a0000000-0000-4000-8000-000000000001";

function errorsOf(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
  return (result.error?.issues ?? []).map((i) => String(i.path[0]));
}

describe("createClientSchema", () => {
  it("needs only a name, and turns blanks into null", () => {
    const parsed = createClientSchema.parse({
      name: "  Coastline Logistics ",
      legalName: "",
      tin: " ",
      billingTermsDays: "",
    });
    expect(parsed).toMatchObject({
      name: "Coastline Logistics",
      legalName: null,
      tin: null,
      billingTermsDays: null,
      contactEmail: null,
    });
  });

  it("normalises RC number, TIN, phone, email and line ends", () => {
    const parsed = createClientSchema.parse({
      name: "Coastline",
      rcNumber: "rc-1234567",
      tin: "12345678-0001",
      billingAddress: "4 Wharf Road\r\nApapa",
      state: "Lagos",
      billingTermsDays: "30",
      contactName: "Ngozi Eze",
      contactEmail: " Accounts@Coastline.NG ",
      contactPhone: "0803 123 4567",
    });
    expect(parsed).toMatchObject({
      rcNumber: "RC 1234567",
      billingAddress: "4 Wharf Road\nApapa",
      billingTermsDays: 30,
      contactEmail: "accounts@coastline.ng",
      contactPhone: "08031234567",
    });
  });

  it("refuses bad values with a message under the field", () => {
    const result = createClientSchema.safeParse({
      name: "",
      tin: "123",
      state: "Atlantis",
      billingTermsDays: "400",
      billingAddress: "visit www.example.com",
      notes: "<script>",
    });
    expect(errorsOf(result).sort()).toEqual(
      ["billingAddress", "billingTermsDays", "name", "notes", "state", "tin"].sort(),
    );
  });

  it("needs an email for a billing contact", () => {
    const result = createClientSchema.safeParse({ name: "Coastline", contactName: "Ngozi" });
    expect(errorsOf(result)).toEqual(["contactEmail"]);
  });

  it("refuses a name that looks like a web address", () => {
    expect(createClientSchema.safeParse({ name: "https://evil.example" }).success).toBe(false);
  });
});

describe("updateClientSchema", () => {
  it("needs the client id", () => {
    expect(errorsOf(updateClientSchema.safeParse({ name: "Coastline" }))).toEqual(["clientId"]);
    expect(updateClientSchema.parse({ clientId: CLIENT, name: "Coastline" }).notes).toBeNull();
  });
});

describe("contact schemas", () => {
  it("reads the primary checkbox and the role", () => {
    const parsed = addContactSchema.parse({
      clientId: CLIENT,
      name: "Chika",
      email: "CHIKA@coastline.ng",
      role: "ops",
      isPrimary: "on",
    });
    expect(parsed).toMatchObject({ email: "chika@coastline.ng", isPrimary: true, phone: null });
    expect(
      addContactSchema.safeParse({ clientId: CLIENT, name: "x", email: "x@y.ng", role: "boss" })
        .success,
    ).toBe(false);
    expect(
      updateContactSchema.parse({ contactId: CLIENT, name: "Chika", email: "c@c.ng" }).isPrimary,
    ).toBe(false);
  });
});

describe("quickAddClientSchema", () => {
  it("takes a name, an optional billing email and an optional site", () => {
    expect(
      quickAddClientSchema.parse({ name: "Marina VI Tower", billingEmail: "", siteName: "" }),
    ).toEqual({
      name: "Marina VI Tower",
      billingEmail: null,
      siteName: null,
    });
    expect(errorsOf(quickAddClientSchema.safeParse({ name: "M", billingEmail: "nope" }))).toEqual([
      "billingEmail",
    ]);
  });
});

describe("client summary", () => {
  const row = (over: Partial<ClientRow>): ClientRow => ({
    id: CLIENT,
    name: "Coastline Logistics",
    legalName: null,
    status: "active",
    siteCount: 1,
    sitesWithoutGeofence: 0,
    activeContractCount: 0,
    primaryBillingEmail: null,
    needsDetails: false,
    ...over,
  });

  it("counts clients, those needing details and sites, without names", () => {
    const summary = summariseClients([
      row({ needsDetails: true, siteCount: 2, sitesWithoutGeofence: 2 }),
      row({ name: "Greenfield" }),
      row({
        name: "Old Co",
        status: "archived",
        needsDetails: true,
        siteCount: 5,
        sitesWithoutGeofence: 5,
      }),
    ]);
    expect(summary).toEqual({
      total: 3,
      active: 2,
      archived: 1,
      needsDetails: 1,
      sites: 3,
      sitesWithoutGeofence: 2,
    });
  });

  it("needs a billing address and a billing contact", () => {
    expect(clientNeedsDetails({ billingAddress: null, hasBillingContact: true })).toBe(true);
    expect(clientNeedsDetails({ billingAddress: "4 Wharf Rd", hasBillingContact: false })).toBe(
      true,
    );
    expect(clientNeedsDetails({ billingAddress: "4 Wharf Rd", hasBillingContact: true })).toBe(
      false,
    );
  });

  it("searches names and registered names, ignoring case and accents", () => {
    const rows = [
      row({ name: "Coastline" }),
      row({ name: "Greenfield", legalName: "Société Verte" }),
    ];
    expect(filterClients(rows, "coast").map((r) => r.name)).toEqual(["Coastline"]);
    expect(filterClients(rows, "SOCIETE").map((r) => r.name)).toEqual(["Greenfield"]);
    expect(filterClients(rows, "")).toHaveLength(2);
  });
});
