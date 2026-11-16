import { describe, expect, it } from "vitest";

import {
  invoiceNumberPreview,
  nextSetupStep,
  ordinal,
  planName,
  previousSetupStep,
  resumeSetupSlug,
  setupDoneCount,
} from "@/lib/company";
import {
  businessStepSchema,
  checkLogo,
  invoicesStepSchema,
  logoObjectPath,
  normaliseBusinessPhone,
  normaliseRcNumber,
  normaliseTin,
  planStepSchema,
} from "@/server/identity/company";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const utf8 = (text: string) => new TextEncoder().encode(text);

describe("normaliseRcNumber", () => {
  it.each([
    ["RC 1234567", "RC 1234567"],
    ["rc1234567", "RC 1234567"],
    ["RC-1234567", "RC 1234567"],
    ["BN 123456", "BN 123456"],
    ["it 12345", "IT 12345"],
    ["1234567", "1234567"],
  ])("%s → %s", (input, expected) => {
    expect(normaliseRcNumber(input)).toBe(expected);
  });

  it.each(["", "RC", "RC 123456789", "XY 123", "RC 12a45", "12 34 56 78 9"])(
    "refuses %j",
    (input) => {
      expect(normaliseRcNumber(input)).toBeNull();
    },
  );
});

describe("normaliseTin", () => {
  it.each([
    ["12345678-0001", "12345678-0001"],
    ["12345678 - 0001", "12345678-0001"],
    ["1234567890", "1234567890"],
    ["1234567890123", "1234567890123"],
  ])("%s → %s", (input, expected) => {
    expect(normaliseTin(input)).toBe(expected);
  });

  it.each(["123456789", "12345678901234", "1234567-0001", "ABCDEFGH-0001", "12345678-001"])(
    "refuses %j",
    (input) => {
      expect(normaliseTin(input)).toBeNull();
    },
  );
});

describe("normaliseBusinessPhone", () => {
  it.each([
    ["0800 000 0000", "08000000000"],
    ["+234 (803) 123-4567", "+2348031234567"],
    ["01-2345678", "012345678"],
  ])("%s → %s", (input, expected) => {
    expect(normaliseBusinessPhone(input)).toBe(expected);
  });

  it.each(["12345", "0800 000 0000 ext 12", "phone", "++2348031234567"])("refuses %j", (input) => {
    expect(normaliseBusinessPhone(input)).toBeNull();
  });
});

describe("planStepSchema", () => {
  it("accepts a plan and a headcount", () => {
    expect(planStepSchema.parse({ plan: "ops_suite", expectedWorkers: " 162 " })).toEqual({
      plan: "ops_suite",
      expectedWorkers: 162,
    });
  });

  it.each([
    [{ plan: "trial", expectedWorkers: "10" }, "plan"],
    [{ plan: "enterprise", expectedWorkers: "10" }, "plan"],
    [{ plan: "starter", expectedWorkers: "0" }, "expectedWorkers"],
    [{ plan: "starter", expectedWorkers: "1.5" }, "expectedWorkers"],
    [{ plan: "starter", expectedWorkers: "1000001" }, "expectedWorkers"],
    [{ plan: "starter", expectedWorkers: "" }, "expectedWorkers"],
  ])("refuses %j", (input, field) => {
    const result = planStepSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path[0]).toBe(field);
  });
});

describe("businessStepSchema", () => {
  const valid = {
    legalName: "Adebayo Facility Services Ltd",
    tradingName: "Adebayo Facility Services",
    rcNumber: "rc 1234567",
    tin: "12345678-0001",
    industry: "security_facility",
    headOfficeState: "Lagos",
    address: "12 Admiralty Way, Lekki Phase 1",
    phone: "0800 000 0000",
    payCycleStartDay: "20",
    payDay: "25",
  };

  it("normalises the business details", () => {
    expect(businessStepSchema.parse(valid)).toEqual({
      ...valid,
      rcNumber: "RC 1234567",
      phone: "08000000000",
      payCycleStartDay: 20,
      payDay: 25,
    });
  });

  it("turns blank optional fields into null", () => {
    const parsed = businessStepSchema.parse({
      ...valid,
      tradingName: " ",
      rcNumber: "",
      tin: "",
      address: "",
      phone: "",
    });
    expect(parsed).toMatchObject({
      tradingName: null,
      rcNumber: null,
      tin: null,
      address: null,
      phone: null,
    });
  });

  it("keeps the field's own message for optional fields", () => {
    const result = businessStepSchema.safeParse({ ...valid, tin: "bad", phone: "12" });
    const messages = Object.fromEntries(
      (result.error?.issues ?? []).map((i) => [String(i.path[0]), i.message]),
    );
    expect(messages).toEqual({
      tin: "Enter the TIN as 12345678-0001, or as 10 to 13 digits",
      phone: "Enter a phone number, for example 0800 000 0000",
    });
  });

  it.each([
    ["legalName", ""],
    ["legalName", "Acme <b>Ltd</b>"],
    ["tradingName", "www.acme.example"],
    ["rcNumber", "RC 123456789"],
    ["tin", "123"],
    ["industry", "mining"],
    ["headOfficeState", "Lagos State"],
    ["phone", "12"],
    ["payCycleStartDay", "29"],
    ["payCycleStartDay", "0"],
    ["payDay", "32"],
  ])("refuses %s = %j", (field, value) => {
    const result = businessStepSchema.safeParse({ ...valid, [field]: value });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0])).toContain(field);
  });
});

describe("invoicesStepSchema", () => {
  const valid = {
    invoiceEmail: " Billing@AdebayoFS.example ",
    invoiceNumberStart: "1",
    paymentTermsDays: "30",
    vatRegistered: "yes",
    autoEmailReceipts: "on",
  };

  it("normalises the invoice settings", () => {
    expect(invoicesStepSchema.parse(valid)).toEqual({
      invoiceEmail: "billing@adebayofs.example",
      invoiceNumberStart: 1,
      paymentTermsDays: 30,
      vatRegistered: "yes",
      autoEmailReceipts: true,
    });
  });

  it("reads a missing checkbox as off", () => {
    const { autoEmailReceipts, ...rest } = valid;
    void autoEmailReceipts;
    expect(invoicesStepSchema.parse(rest).autoEmailReceipts).toBe(false);
  });

  it.each([
    ["invoiceEmail", "not-an-email"],
    ["invoiceEmail", ""],
    ["invoiceNumberStart", "0"],
    ["invoiceNumberStart", "INV-0001"],
    ["paymentTermsDays", "366"],
    ["vatRegistered", "maybe"],
  ])("refuses %s = %j", (field, value) => {
    const result = invoicesStepSchema.safeParse({ ...valid, [field]: value });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0])).toContain(field);
  });
});

describe("checkLogo", () => {
  it("accepts a PNG by its signature", () => {
    expect(checkLogo(PNG)).toEqual({ ok: true, ext: "png", contentType: "image/png" });
  });

  it("accepts a plain SVG, with an XML declaration, comments and internal references", () => {
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<!-- exported -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 28 28">
  <defs><linearGradient id="g"><stop offset="0" /></linearGradient></defs>
  <circle cx="5" cy="5" r="3" fill="url(#g)" /><use xlink:href="#g" />
</svg>`;
    expect(checkLogo(utf8(svg))).toEqual({ ok: true, ext: "svg", contentType: "image/svg+xml" });
  });

  it("accepts an SVG with ordinary character references and a harmless animation", () => {
    const svg =
      '<svg viewBox="0 0 10 10"><text>A&#160;&amp;&#x20;B</text>' +
      '<circle r="2"><animate attributeName="r" values="2;3;2" dur="2s" /></circle></svg>';
    expect(checkLogo(utf8(svg)).ok).toBe(true);
  });

  it.each([
    ["a script", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ["an event handler", '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'],
    ["a javascript: link", '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>'],
    ["an external image", '<svg><image href="https://evil.example/x.png" /></svg>'],
    ["an external xlink", '<svg><use xlink:href="https://evil.example/s.svg#a" /></svg>'],
    ["embedded HTML", "<svg><foreignObject><div>x</div></foreignObject></svg>"],
    ["an entity declaration", '<!DOCTYPE svg [<!ENTITY x "y">]><svg>&x;</svg>'],
    ["a CSS import", "<svg><style>@import 'https://evil.example/a.css';</style></svg>"],
    ["an external CSS url", "<svg><style>a{fill:url(https://evil.example/x)}</style></svg>"],
    [
      "an animation that rewrites a link",
      '<svg><a><animate attributeName="href" values="#a" /><text>x</text></a></svg>',
    ],
    ["a set that rewrites a link", '<svg><a><set attributeName="xlink:href" to="#a" /></a></svg>'],
    [
      "an entity-encoded javascript: link",
      '<svg><a href="#a"><animate values="&#106;avascript:alert(1)" /></a></svg>',
    ],
    ["a hex-encoded javascript: link", "<svg><a><text>&#x6A;avascript&#x3a;x</text></a></svg>"],
    ["an encoded script tag", "<svg><text>&lt;script&gt;</text></svg>"],
  ])("refuses an SVG with %s", (_label, svg) => {
    const result = checkLogo(utf8(svg));
    expect(result.ok).toBe(false);
  });

  it.each([
    ["an empty file", new Uint8Array()],
    ["a JPEG", Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])],
    ["HTML", utf8("<html><body>logo</body></html>")],
    ["a file over 1 MB", new Uint8Array(1024 * 1024 + 1).fill(0x20)],
  ])("refuses %s", (_label, bytes) => {
    expect(checkLogo(bytes).ok).toBe(false);
  });

  it("accepts a PNG of exactly 1 MB and refuses one byte more", () => {
    const exact = new Uint8Array(1024 * 1024);
    exact.set(PNG);
    expect(checkLogo(exact).ok).toBe(true);
    const over = new Uint8Array(1024 * 1024 + 1);
    over.set(PNG);
    expect(checkLogo(over)).toEqual({ ok: false, message: "The logo must be under 1 MB." });
  });

  it("names the object inside the organisation's folder", () => {
    expect(logoObjectPath("a0000000-0000-4000-8000-000000000001", "svg")).toBe(
      "a0000000-0000-4000-8000-000000000001/logo.svg",
    );
  });
});

describe("setup wizard steps", () => {
  it("counts done steps from the furthest step reached", () => {
    expect(setupDoneCount(1, false)).toBe(0);
    expect(setupDoneCount(3, false)).toBe(2);
    expect(setupDoneCount(6, false)).toBe(5);
    expect(setupDoneCount(2, true)).toBe(5);
  });

  it("resumes at the furthest step, or Ready once complete", () => {
    expect(resumeSetupSlug(1, false)).toBe("plan");
    expect(resumeSetupSlug(4, false)).toBe("clients");
    expect(resumeSetupSlug(6, false)).toBe("employees");
    expect(resumeSetupSlug(3, true)).toBe("ready");
  });

  it("links each step to its neighbours", () => {
    expect(previousSetupStep("plan")).toBeNull();
    expect(previousSetupStep("business")?.slug).toBe("plan");
    expect(nextSetupStep("employees")?.slug).toBe("ready");
    expect(nextSetupStep("ready")).toBeNull();
  });

  it("formats days, invoice numbers and plan names", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "23rd",
      "31st",
    ]);
    expect(invoiceNumberPreview(1)).toBe("INV-0001");
    expect(invoiceNumberPreview(12345)).toBe("INV-12345");
    expect(planName("ops_suite")).toBe("Ops Suite");
    expect(planName("trial")).toBe("Trial");
  });
});
