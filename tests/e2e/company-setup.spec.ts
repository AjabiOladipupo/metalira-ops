import { expect, test, type Page } from "@playwright/test";

import { adminClient } from "../rls/helpers/supabase";
import {
  NEEDS_SUPABASE,
  addMembership,
  createAccount,
  createOwner,
  signInViaUi,
  supabaseReady,
  uniqueSuffix,
} from "./helpers/auth";

test.skip(!supabaseReady, NEEDS_SUPABASE);

// A 1×1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function expectStep(page: Page, slug: string, heading: string, done: number) {
  // Each step lands through a server action redirect (or, first time, the dashboard's
  // streamed redirect): allow for a busy local stack.
  await expect(page).toHaveURL(new RegExp(`/app/setup/${slug}$`), { timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
  await expect(visible(page, "setup-progress")).toHaveText(`${done} of 5 done`);
  await expectNoHorizontalScroll(page);
}

/**
 * By test id, visible only: Next keeps recently visited pages mounted but hidden, so an earlier
 * step's copy of the same element can still be in the DOM.
 */
const visible = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });

const cont = (page: Page) => page.getByRole("button", { name: "Continue", exact: true });

test("a new owner completes company setup and every save is audited", async ({ page }) => {
  // Six steps, a file upload and a dozen server round trips.
  test.setTimeout(120_000);
  const suffix = uniqueSuffix();
  const owner = await createOwner("setup", `Adebayo Facility ${suffix}`, { setupDone: false });

  // Signing in sends an owner with no finished setup to the wizard.
  await signInViaUi(page, owner.email, owner.password);
  await expectStep(page, "plan", "Your plan", 0);
  await expect(page.getByText("Everything here can be changed later in Settings.")).toBeVisible();

  // 1. Plan: a plan and a headcount; no prices.
  await expect(page.getByText(/₦/)).toHaveCount(0);
  await page.getByRole("radio", { name: /^Workforce People/ }).check({ force: true });
  await page.getByRole("spinbutton", { name: "Workers you expect each month" }).fill("162");
  await cont(page).click();

  // 2. Business details, with the logo.
  await expectStep(page, "business", "Your business", 1);
  await page.locator('input[type="file"][name="logo"]').setInputFiles({
    name: "logo.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  // Upload, Storage write and a fresh signed URL: allow for a busy local stack.
  await expect(page.getByText("Logo saved")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("img", { name: /logo$/ })).toBeVisible();
  // The logo shows in the shell's company switcher.
  await expect(visible(page, "company-logo")).toBeVisible();

  const tradingName = `Adebayo FS ${suffix}`;
  await page
    .getByRole("textbox", { name: "Registered business name" })
    .fill(`Adebayo Facility Services ${suffix} Ltd`);
  await page.getByRole("textbox", { name: "Trading name" }).fill(tradingName);
  await page.getByRole("textbox", { name: "CAC RC number" }).fill("rc1234567");
  await page.getByRole("textbox", { name: "Tax ID (TIN)" }).fill("bad");
  await page.getByRole("combobox", { name: "Industry" }).selectOption({
    label: "Security and facility services",
  });
  await page.getByRole("combobox", { name: "Head office state" }).selectOption("Lagos");
  await page.getByRole("textbox", { name: "Office address" }).fill("12 Admiralty Way, Lekki");
  await page.getByRole("textbox", { name: "Business phone" }).fill("0800 000 0000");
  await cont(page).click();
  // A bad TIN is explained under the field and nothing moves on.
  await expect(
    page.getByText("Enter the TIN as 12345678-0001, or as 10 to 13 digits"),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/app\/setup\/business$/);
  await expect(page.getByRole("textbox", { name: "Trading name" })).toHaveValue(tradingName);
  await page.getByRole("textbox", { name: "Tax ID (TIN)" }).fill("12345678-0001");
  await cont(page).click();

  // 3. Invoices and payments: the company's own bank account only (added in slice 2.3's own
  // spec, company-bank-account.spec.ts).
  await expectStep(page, "invoices", "Invoices and getting paid", 2);
  await expect(page.getByTestId("rail-status")).toHaveText("No account yet");
  await expect(page.getByRole("link", { name: "Add bank account" })).toBeVisible();
  await expect(page.getByText("Bank account", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Invoice email" }).fill(`billing-${suffix}@example.test`);
  await page.getByRole("combobox", { name: "Payment terms" }).selectOption({ label: "14 days" });
  await cont(page).click();

  // 4. Clients: a quick add (client, billing email, first site) lands in the board's table.
  await expectStep(page, "clients", "Clients and contracts", 3);
  const quickAdd = page.getByRole("form", { name: "Add client" });
  await quickAdd.getByRole("textbox", { name: "Client", exact: true }).fill("Coastline Logistics");
  await quickAdd.getByRole("textbox", { name: "Billing email" }).fill("bad");
  await quickAdd.getByRole("button", { name: "Add client" }).click();
  await expect(quickAdd.getByText("Enter a valid email address")).toBeVisible();
  await quickAdd
    .getByRole("textbox", { name: "Billing email" })
    .fill(`accounts-${suffix}@coastline.example`);
  await quickAdd.getByRole("textbox", { name: "First site" }).fill("Apapa Warehouse 3");
  await quickAdd.getByRole("button", { name: "Add client" }).click();
  await expect(quickAdd.getByText("Coastline Logistics added")).toBeVisible({ timeout: 15_000 });
  const added = page.getByRole("region", { name: "Clients added table" });
  await expect(added.getByRole("row", { name: /Coastline Logistics/ })).toContainText(
    "Apapa Warehouse 3",
  );
  await expect(added.getByText("Add a contract")).toBeVisible();
  await expectNoHorizontalScroll(page);
  await cont(page).click();

  // 5. Employees (the import itself is covered by people-import.spec.ts).
  await expectStep(page, "employees", "Bring in your employees", 4);
  await expect(page.getByRole("link", { name: "Download template (.csv)" })).toBeVisible();
  await page.getByRole("button", { name: "Finish setup" }).click();

  // 6. Ready.
  await expectStep(page, "ready", `${tradingName} is set up`, 5);
  const code = (await visible(page, "company-code").textContent())?.trim() ?? "";
  expect(code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
  await expect(page.getByTestId("org-switcher")).toHaveText(tradingName);

  // The wizard's own address resumes where setup stands: Ready, once complete.
  await page.goto("/app/setup");
  await expect(page).toHaveURL(/\/app\/setup\/ready$/);

  await page.getByRole("link", { name: "Go to the dashboard" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Home", { timeout: 15_000 });

  // The saved company, and an audit row for every save with the owner as actor.
  const admin = adminClient();
  const { data: org } = await admin
    .from("organisations")
    .select("*")
    .eq("id", owner.orgId)
    .single();
  expect(org).toMatchObject({
    name: tradingName,
    plan: "workforce",
    expected_workers: 162,
    rc_number: "RC 1234567",
    tin: "12345678-0001",
    industry: "security_facility",
    head_office_state: "Lagos",
    phone: "08000000000",
    invoice_email: `billing-${suffix}@example.test`,
    payment_terms_days: 14,
    logo_path: `${owner.orgId}/logo.png`,
    company_code: code,
    setup_step: 6,
  });
  expect(org?.setup_completed_at).not.toBeNull();

  const { data: audit } = await admin
    .from("audit_log")
    .select("action, actor_id")
    .eq("organisation_id", owner.orgId)
    .neq("action", "memberships.insert")
    .neq("action", "organisations.insert");
  const actions = (audit ?? []).map((row) => row.action);
  expect(actions).toContain("company.logo_uploaded");
  // The quick add: client, primary billing contact and site, in one transaction.
  expect(actions).toEqual(
    expect.arrayContaining(["clients.insert", "client_contacts.insert", "sites.insert"]),
  );
  // Plan, progress, logo path, business details, invoices, progress twice, completion.
  expect(actions.filter((a) => a === "organisations.update").length).toBeGreaterThanOrEqual(7);
  expect((audit ?? []).every((row) => row.actor_id === owner.userId)).toBe(true);

  await admin.storage.from("org-assets").remove([`${owner.orgId}/logo.png`]);
});

test("company settings reuse the setup forms and save in place", async ({ page }) => {
  const owner = await createOwner("settings", `Settings Co ${uniqueSuffix()}`);
  await signInViaUi(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/app$/);

  await page.goto("/app/settings");
  await page.getByRole("link", { name: /Company/ }).click();
  await expect(page).toHaveURL(/\/app\/settings\/company$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Company");
  await expect(visible(page, "company-code")).toHaveText(/^[2-9A-HJKMNP-Z]{6}$/);
  await expectNoHorizontalScroll(page);

  const business = page.getByRole("region", { name: "Business details" });
  const renamed = `Renamed Co ${uniqueSuffix()}`;
  await business.getByRole("textbox", { name: "Trading name" }).fill(renamed);
  await business.getByRole("combobox", { name: "Industry" }).selectOption({ label: "Cleaning" });
  await business.getByRole("combobox", { name: "Head office state" }).selectOption("Rivers");
  await business.getByRole("button", { name: "Save changes" }).click();
  await expect(business.getByText("Saved", { exact: true })).toBeVisible();
  await expect(page.getByTestId("org-switcher")).toHaveText(renamed);
  await expect(business.getByRole("combobox", { name: "Head office state" })).toHaveValue("Rivers");

  // Saving from settings never sends the owner back into the wizard.
  await page.goto("/app");
  await expect(page).toHaveURL(/\/app$/);
});

test("hr cannot open the setup wizard or company settings", async ({ page }) => {
  // Four page loads, three of them redirected: allow for a busy local stack.
  test.setTimeout(60_000);
  const owner = await createOwner("hr-owner", `HR Co ${uniqueSuffix()}`, { setupDone: false });
  const hr = await createAccount("hr");
  await addMembership(owner.orgId, hr.userId, "hr");

  await signInViaUi(page, hr.email, hr.password);
  // Not sent to the wizard: setup belongs to owners and admins.
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Home");

  for (const path of ["/app/setup", "/app/setup/business", "/app/settings/company"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/no-access$/);
  }

  await page.goto("/app/settings");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
  await expect(page.getByRole("link", { name: /Company/ })).toHaveCount(0);
});
