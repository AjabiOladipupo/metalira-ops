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
import { test as ownerTest } from "./helpers/signed-in";

/**
 * Every page has a back arrow to its logical parent (not browser history) and a theme switcher
 * in its header; the three home pages (/, /app, /m) have no back arrow. People offers Invite to
 * the roles that can invite.
 */

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Opens `path` directly (as from an email) and follows its back arrow. */
async function expectBack(page: Page, path: string, name: string, parent: RegExp) {
  await page.goto(path);
  // The arrow, by its accessible name (a page may also have a text link to the same place).
  const back = page.getByTestId("back-link");
  await expect(back).toHaveCount(1);
  await expect(back).toHaveAccessibleName(name);
  await expect(back).toBeVisible();
  const box = await back.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await back.click();
  await expect(page).toHaveURL(parent);
}

/** The header theme button switches to dark, the choice survives a reload, then back to light. */
async function expectThemeButton(page: Page) {
  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  const button = page.getByRole("button", { name: /^Theme: / });
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await button.click();
  await page.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByRole("button", { name: "Theme: Dark" })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.getByRole("button", { name: "Theme: Dark" }).click();
  await page.getByRole("menuitemradio", { name: "System" }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
}

test.describe("public pages", () => {
  test("theme button in the headers of the landing, sign-in and worker sign-in", async ({
    page,
  }) => {
    for (const path of ["/", "/for/hr", "/sign-in", "/sign-up", "/m/sign-in"]) {
      await page.goto(path);
      await expectThemeButton(page);
    }
  });

  test("back arrows go to the logical parent; the landing has none", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("back-link")).toHaveCount(0);
    await expectBack(page, "/for/finance", "Back to home", /\/$/);
    await expectBack(page, "/sign-in", "Back to home", /\/$/);
    await expectBack(page, "/sign-up", "Back to home", /\/$/);
    await expectBack(page, "/check-email", "Back to sign in", /\/sign-in$/);
    await expectBack(page, "/design-system", "Back to home", /\/$/);
    await expectBack(page, "/m/sign-in", "Back to Metalira Ops for workers", /\/for\/workers$/);
  });
});

ownerTest.describe("manager app", () => {
  ownerTest.skip(!supabaseReady, NEEDS_SUPABASE);

  ownerTest("the shell header has the theme button", async ({ page }) => {
    await page.goto("/app");
    await expectThemeButton(page);
  });

  ownerTest(
    "back arrows go to the logical parent; the dashboard has none",
    async ({ page, owner }) => {
      await page.goto("/app");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByTestId("back-link")).toHaveCount(0);

      await expectBack(page, "/app/payroll", "Back to dashboard", /\/app$/);
      await expectBack(page, "/app/settings", "Back to dashboard", /\/app$/);
      await expectBack(page, "/app/settings/company", "Back to Settings", /\/app\/settings$/);
      await expectBack(page, "/app/settings/departments", "Back to Settings", /\/app\/settings$/);
      await expectBack(page, "/app/people", "Back to dashboard", /\/app$/);
      await expectBack(page, "/app/people/invites", "Back to People", /\/app\/people$/);
      await expectBack(page, "/app/people/import", "Back to People", /\/app\/people$/);
      await expectBack(page, "/app/people/approvals", "Back to People", /\/app\/people$/);
      await expectBack(page, "/app/people/new", "Back to People", /\/app\/people$/);

      const { data: worker, error } = await adminClient()
        .from("workers")
        .insert({
          organisation_id: owner.orgId,
          staff_id: `NAV-${uniqueSuffix()}`,
          first_name: "Bisi",
          last_name: "Nav",
          employment_type: "permanent",
          start_date: "2025-01-06",
        })
        .select("id")
        .single();
      if (error || !worker) throw new Error(`Seeding failed: ${error?.message ?? "no data"}`);
      await expectBack(page, `/app/people/${worker.id}`, "Back to People", /\/app\/people$/);
      await expectBack(
        page,
        `/app/people/${worker.id}/edit`,
        "Back to Bisi Nav",
        new RegExp(`/app/people/${worker.id}$`),
      );
      await expectNoHorizontalScroll(page);
    },
  );

  ownerTest("People has Invite next to Import, going to worker invites", async ({ page }) => {
    await page.goto("/app/people");
    const invite = page.getByRole("link", { name: "Invite", exact: true });
    await expect(page.getByRole("link", { name: "Import", exact: true })).toBeVisible();
    await expect(invite).toHaveAttribute("href", "/app/people/invites");
    await invite.click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Worker invites");
  });
});

test("finance goes back from bank-detail approvals to the dashboard, not People", async ({
  page,
}) => {
  test.skip(!supabaseReady, NEEDS_SUPABASE);
  const owner = await createOwner("nav-owner", `Nav Finance Co ${uniqueSuffix()}`);
  const finance = await createAccount("nav-finance", "Funmi Ade");
  await addMembership(owner.orgId, finance.userId, "finance");
  await signInViaUi(page, finance.email, finance.password);
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });
  await expectBack(page, "/app/people/approvals", "Back to dashboard", /\/app$/);
  // One back link only: the old text link to People is gone.
  await page.goto("/app/people/approvals");
  await expect(page.getByRole("link", { name: "People", exact: true })).toHaveCount(0);
});
