/**
 * Slice 1.10, the pure parts of the worker app: the bottom nav, the Me screen's masked rows,
 * the "no personal numbers" rule for change requests, the web app manifest, the messages module,
 * and the rule that worker screens read with the worker's own session, never the secret key.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { workerMessages } from "@/lib/messages/worker";
import { WORKER_NAV, activeWorkerNav } from "@/lib/worker-nav";
import { myProfileSections, type MyProfileInput } from "@/lib/worker-profile";
import {
  REQUEST_CHOICES,
  WORKER_CHANGE_TOPICS,
  hasPersonalNumber,
  isPlainRequestText,
  normaliseRequestText,
} from "@/lib/worker-requests";

import { ROOT, sourceFiles } from "./helpers/source-files";

describe("bottom nav", () => {
  it("has Home, Clock, Leave, Payslips and Me, in that order (DESIGN_SYSTEM.md)", () => {
    expect(WORKER_NAV.map((i) => [i.label, i.href])).toEqual([
      ["Home", "/m"],
      ["Clock", "/m/clock"],
      ["Leave", "/m/leave"],
      ["Payslips", "/m/payslips"],
      ["Me", "/m/me"],
    ]);
  });

  it("marks Home only on /m, and each other item on its own pages", () => {
    expect(activeWorkerNav("/m")).toBe("home");
    expect(activeWorkerNav("/m/")).toBe("home");
    expect(activeWorkerNav("/m/me")).toBe("me");
    expect(activeWorkerNav("/m/me/change")).toBe("me");
    expect(activeWorkerNav("/m/clock")).toBe("clock");
    expect(activeWorkerNav("/m/payslips")).toBe("payslips");
    expect(activeWorkerNav("/m/help")).toBeNull();
    expect(activeWorkerNav("/m/mexico")).toBeNull();
  });
});

const PROFILE: MyProfileInput = {
  departmentName: "Security services",
  lineManager: { isSet: true, name: "Kola Adebayo" },
  siteNames: ["Apapa Warehouse 3"],
  projectNames: ["Coastline guarding contract"],
  startDate: "2024-03-03",
  employmentType: "permanent",
  bankName: "GTBank",
  bankAccountLast4: "7712",
  pfaName: "Stanbic IBTC",
  rsaPinOnFile: true,
  rsaPinLast4: "4421",
  taxState: "Lagos",
  annualRentDeclared: 36_000_000n,
  ninOnFile: true,
  phone: "08031234410",
  nextOfKinName: "Aisha Ibrahim",
  nextOfKinPhone: "+2348099991234",
};

function rows(input: MyProfileInput): Record<string, string | null> {
  return Object.fromEntries(
    myProfileSections(input).flatMap((s) => s.rows.map((r) => [r.testId, r.value])),
  );
}

describe("Me screen rows (WkProfile board)", () => {
  it("shows work, pay and identity with every personal number masked", () => {
    expect(myProfileSections(PROFILE).map((s) => s.title)).toEqual([
      "Work",
      "Pay and pension",
      "Identity and contact",
    ]);
    expect(rows(PROFILE)).toEqual({
      "me-department": "Security services",
      "me-line-manager": "Kola Adebayo",
      "me-site": "Apapa Warehouse 3",
      "me-project": "Coastline guarding contract",
      "me-started": "3 Mar 2024 · permanent",
      "me-bank": "GTBank ••••7712",
      "me-pension": "Stanbic IBTC · PEN••••4421",
      "me-tax-state": "Lagos",
      "me-rent": "₦360,000 a year",
      "me-nin": "On file",
      "me-phone": "0803 ••• 4410",
      "me-next-of-kin": "Aisha Ibrahim · 0809 ••• 1234",
    });
  });

  it("says Missing for a NIN not on file, never Verified (owner decision 8)", () => {
    expect(rows({ ...PROFILE, ninOnFile: false })["me-nin"]).toBe("Missing");
    const all = JSON.stringify(myProfileSections(PROFILE));
    expect(all).not.toMatch(/verified/i);
  });

  it("leaves empty fields to show as Not set", () => {
    const empty = rows({
      ...PROFILE,
      departmentName: null,
      lineManager: { isSet: false, name: null },
      siteNames: [],
      projectNames: [],
      bankName: null,
      bankAccountLast4: null,
      pfaName: null,
      rsaPinOnFile: false,
      rsaPinLast4: null,
      taxState: null,
      annualRentDeclared: null,
      phone: null,
      nextOfKinName: null,
      nextOfKinPhone: null,
    });
    for (const key of [
      "me-department",
      "me-line-manager",
      "me-site",
      "me-project",
      "me-bank",
      "me-pension",
      "me-tax-state",
      "me-rent",
      "me-phone",
      "me-next-of-kin",
    ]) {
      expect(empty[key], key).toBeNull();
    }
  });

  it("names a line manager whose name the worker can't see as set by HR", () => {
    expect(rows({ ...PROFILE, lineManager: { isSet: true, name: null } })["me-line-manager"]).toBe(
      "Set by HR",
    );
  });

  it("lists several sites and projects", () => {
    const r = rows({ ...PROFILE, siteNames: ["Gate A", "Gate B"], projectNames: [] });
    expect(r["me-site"]).toBe("Gate A, Gate B");
    expect(r["me-project"]).toBeNull();
  });
});

describe("change request text", () => {
  it("refuses NIN, account, RSA PIN and phone numbers, even split up", () => {
    for (const text of [
      "My NIN is 12345678901",
      "New account 0123457712",
      "PEN100012344421",
      "Call me on 0803 123 4567",
      "0803-123-4567",
      "(0803) 123.4567",
      "+234 803 123 4567",
    ]) {
      expect(hasPersonalNumber(text), text).toBe(true);
    }
  });

  it("allows ordinary words, dates and short numbers", () => {
    for (const text of [
      "My surname is spelt Adebayo, not Adebayor",
      "I moved to Gate 3 on 12 Nov 2026",
      "Next of kin is my sister Aisha",
      "Started on 2024-03-03",
    ]) {
      expect(hasPersonalNumber(text), text).toBe(false);
    }
  });

  it("keeps line breaks, trims, and refuses other control characters and < >", () => {
    expect(normaliseRequestText("  one\r\ntwo  ")).toBe("one\ntwo");
    expect(isPlainRequestText("one\ntwo")).toBe(true);
    expect(isPlainRequestText("a<b")).toBe(false);
    expect(isPlainRequestText("tab\there")).toBe(false);
  });

  it("offers bank details first, then every topic the database knows", () => {
    expect(REQUEST_CHOICES[0]).toBe("bank");
    expect(REQUEST_CHOICES.slice(1)).toEqual(WORKER_CHANGE_TOPICS);
    for (const choice of REQUEST_CHOICES) {
      expect(workerMessages.change.topics[choice]).toBeTruthy();
    }
  });
});

describe("web app manifest", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, "public", "worker.webmanifest"), "utf8"),
  ) as {
    start_url: string;
    scope: string;
    display: string;
    icons: { src: string; sizes: string; purpose: string }[];
  };

  it("installs the worker app only, standalone", () => {
    expect(manifest.start_url).toBe("/m");
    expect(manifest.scope).toBe("/m");
    expect(manifest.display).toBe("standalone");
  });

  it("has 192 and 512 icons and a maskable one, all present in public/", () => {
    const sizes = manifest.icons.map((i) => `${i.sizes} ${i.purpose}`);
    expect(sizes).toEqual(
      expect.arrayContaining(["192x192 any", "512x512 any", "512x512 maskable"]),
    );
    for (const icon of manifest.icons) {
      expect(existsSync(path.join(ROOT, "public", icon.src)), icon.src).toBe(true);
    }
  });

  it("is linked from the worker app layout", () => {
    const layout = readFileSync(path.join(ROOT, "src", "app", "m", "layout.tsx"), "utf8");
    expect(layout).toContain('manifest: "/worker.webmanifest"');
  });
});

/** Every string in the messages module, functions called with sample arguments. */
function allMessages(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "function") {
    return [String((value as (...a: unknown[]) => unknown)("Sample", "Sample"))];
  }
  if (value && typeof value === "object") return Object.values(value).flatMap(allMessages);
  return [];
}

describe("worker messages module (owner decision 16)", () => {
  it("has no emoji or exclamation marks", () => {
    for (const text of allMessages(workerMessages)) {
      expect(text, text).not.toMatch(/!|\p{Extended_Pictographic}/u);
    }
  });

  it("keeps worker screens free of a language picker", () => {
    const files = sourceFiles().filter((f) => f.file.startsWith("src/app/m/"));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      expect(file.text, file.file).not.toMatch(/Language|Pidgin|Yorùbá|Hausa|Igbo/);
    }
  });
});

describe("worker reads use the worker's own session", () => {
  it("never reach the secret-key client from worker screens or their loaders", () => {
    const worker = sourceFiles().filter(
      (f) =>
        f.file.startsWith("src/app/m/(app)/") ||
        f.file === "src/server/people/my-profile.ts" ||
        f.file === "src/server/people/own-requests.ts",
    );
    expect(worker.length).toBeGreaterThanOrEqual(5);
    for (const file of worker) {
      expect(file.text, file.file).not.toMatch(/supabase\/admin|createAdminSupabase|SECRET_KEY/);
    }
  });
});
