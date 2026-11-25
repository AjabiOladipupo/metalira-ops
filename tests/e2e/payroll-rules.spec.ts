/**
 * Slice 5.0: Settings > Payroll rules shows the PAYE bands and every figure with "Confirm with a
 * tax adviser before the first live payroll". HR previews a new version (the figures that
 * change) and saves it from tomorrow; Finance reads the page without "Add a version"; an admin
 * can't open it. Works at 1440px and 390px.
 */
import { expect, test, type Page } from "@playwright/test";

import { addDays, formatDate, lagosToday } from "../../src/lib/dates";
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

const ADVISER = "Confirm with a tax adviser before the first live payroll.";

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("HR sees the bands with the adviser line, previews and saves a version from tomorrow", async ({
  page,
}) => {
  const owner = await createOwner("rules-owner", `Kola Guarding ${uniqueSuffix()}`);
  const hr = await createAccount("rules-hr", "Hauwa Bello");
  await addMembership(owner.orgId, hr.userId, "hr");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signInViaUi(page, hr.email, hr.password);
  await expect(page).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });

  await page.goto("/app/settings");
  await page.getByRole("link", { name: /Payroll rules/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Payroll rules" })).toBeVisible();
  await expect(page.getByTestId("adviser-line")).toContainText(ADVISER);
  const bands = page.getByRole("table", { name: "PAYE bands, a year" });
  for (const [band, rate] of [
    ["First ₦800,000", "0%"],
    ["Next ₦2,200,000", "15%"],
    ["Next ₦9,000,000", "18%"],
    ["Next ₦13,000,000", "21%"],
    ["Next ₦25,000,000", "23%"],
    ["Above ₦50,000,000", "25%"],
  ]) {
    await expect(bands.getByRole("row", { name: new RegExp(band!) })).toContainText(rate!);
  }
  await expect(page.getByText("20% of declared annual rent, capped at ₦500,000")).toBeVisible();
  await expect(page.getByText("8% of basic + housing + transport")).toBeVisible();

  await page.getByRole("link", { name: "Add a version" }).click();
  const form = page.getByRole("form", { name: "Add a version of the payroll rules" });
  await form.getByLabel("Reason").fill("Tax adviser's advice");
  await form.getByLabel("NSITF (%)").fill("1.5");
  await form.getByRole("button", { name: "Preview changes" }).click();
  await expect(form.getByTestId("rule-set-preview")).toContainText(
    `NTA 2025 v3 changes 1 figure from ${formatDate(addDays(lagosToday(), 1))}`,
  );
  await expect(form.getByRole("listitem").filter({ hasText: "NSITF" })).toContainText(
    "1% of monthly payroll → 1.5% of monthly payroll",
  );
  await form.getByRole("button", { name: "Save version" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Version saved" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Scheduled" })).toBeVisible();
  await expect(page.getByText(/NTA 2025 v3 · from .* · 1 figure changes/)).toBeVisible();

  await page.setViewportSize({ width: 390, height: 900 });
  await page.reload();
  await expect(page.getByTestId("adviser-line")).toContainText(ADVISER);
  await expectNoHorizontalScroll(page);
  await page.goto("/app/settings/payroll/new");
  await expect(
    page.getByRole("form", { name: "Add a version of the payroll rules" }),
  ).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test("Finance reads the rules without editing; an admin can't open them", async ({ page }) => {
  const owner = await createOwner("rules-owner2", `Clean Co ${uniqueSuffix()}`);
  const finance = await createAccount("rules-finance", "Adaeze Nwosu");
  const admin = await createAccount("rules-admin", "Bola Ade");
  await addMembership(owner.orgId, finance.userId, "finance");
  await addMembership(owner.orgId, admin.userId, "admin");

  await page.setViewportSize({ width: 390, height: 900 });
  await signInViaUi(page, finance.email, finance.password);
  await expect(page).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });
  await page.goto("/app/settings/payroll");
  await expect(page.getByRole("heading", { level: 1, name: "Payroll rules" })).toBeVisible();
  await expect(page.getByTestId("adviser-line")).toContainText(ADVISER);
  await expect(page.getByRole("link", { name: "Add a version" })).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  await page.context().clearCookies();
  await signInViaUi(page, admin.email, admin.password);
  await expect(page).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });
  await page.goto("/app/settings/payroll");
  await expect(page.getByRole("heading", { level: 1, name: "Payroll rules" })).toHaveCount(0);
});
