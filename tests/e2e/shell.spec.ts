import type { Page } from "@playwright/test";

import { NAV_ITEMS } from "../../src/lib/nav";
import { NEEDS_SUPABASE, supabaseReady } from "./helpers/auth";
import { expect, test } from "./helpers/signed-in";

// /app needs a session now: every check here runs as a signed-in owner, who sees every page.
test.skip(!supabaseReady, NEEDS_SUPABASE);

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const item of NAV_ITEMS) {
  test(`${item.href} loads with its heading`, async ({ page }) => {
    await page.goto(item.href);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(item.label);
    await expect(page.getByText(item.empty)).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
}

test("desktop sidebar marks the current page", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-1440", "Sidebar is desktop only");
  await page.goto("/app/timesheets");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Timesheets" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await nav.getByRole("link", { name: "Collections" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Collections");
  await expect(page.getByRole("button", { name: "Open menu" })).toBeHidden();
});

test("mobile menu opens and navigates", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-390", "Menu button is mobile only");
  await page.goto("/app");
  await page.getByRole("button", { name: "Open menu" }).click();
  const dialog = page.getByRole("dialog", { name: "Menu" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("link", { name: "Payroll run" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Payroll run");
  await expect(dialog).toBeHidden();
});

test("theme choice in the account menu switches to dark and persists", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/app");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("button", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
});
