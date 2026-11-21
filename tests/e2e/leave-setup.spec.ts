/**
 * Slice 4.1: an owner sees the two leave presets, each with its source and "confirm with an
 * adviser", applies preset B after its preview, and changes annual leave to 18 days from the next
 * 1 January. HR adds a public holiday. Settings > Leave works at 390px and 1440px.
 */
import { expect, test, type Page } from "@playwright/test";

import { formatDate, lagosToday } from "../../src/lib/dates";
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

const year = Number(lagosToday().slice(0, 4));

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("apply preset B, set annual leave to 18 days, and see the adviser line on both presets", async ({
  page,
}) => {
  const owner = await createOwner("leave-owner", `Kola Guarding ${uniqueSuffix()}`);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signInViaUi(page, owner.email, owner.password);

  await page.goto("/app/settings/leave");
  await expect(page.getByRole("heading", { level: 1, name: "Leave" })).toBeVisible();
  for (const id of ["A", "B"]) {
    const card = page.getByTestId(`preset-card-${id}`);
    await expect(card).toContainText("Source:");
    await expect(card).toContainText(/confirm them with an adviser/i);
  }
  await expect(page.getByTestId("preset-card-C")).toHaveCount(0);

  await page.getByRole("link", { name: "Use preset B" }).click();
  await expect(page.getByTestId("preset-preview")).toContainText("adds 5 leave types");
  await page.getByRole("button", { name: "Apply preset B" }).click();
  await expect(page.getByText("Preset B applied.")).toBeVisible();

  const table = page.getByRole("region", { name: "Leave types table" });
  const annual = table.getByRole("row", { name: /Annual/ });
  await expect(annual).toContainText("15");
  await expect(annual).toContainText("Common private-sector practice");

  await page.getByRole("link", { name: "Edit Annual" }).click();
  const form = page.getByRole("form", { name: "Days and pay" });
  await form.getByLabel("Days a year").fill("18");
  await form.getByRole("button", { name: "Save days and pay" }).click();
  await expect(form.getByRole("status")).toContainText(
    `18 days a year from ${formatDate(`${year + 1}-01-01`)}`,
  );

  await page.goto("/app/settings/leave");
  await expect(table.getByRole("row", { name: /Annual/ })).toContainText(
    `From ${formatDate(`${year + 1}-01-01`)}: 18 working days`,
  );

  await page.setViewportSize({ width: 390, height: 900 });
  await page.reload();
  await expect(page.getByTestId("preset-card-B")).toContainText(/confirm them with an adviser/i);
  await expectNoHorizontalScroll(page);
});

test("HR adds a public holiday and sets the working week", async ({ page }) => {
  const owner = await createOwner("holiday-owner", `Clean Co ${uniqueSuffix()}`);
  const hr = await createAccount("holiday-hr", "Hauwa Bello");
  await addMembership(owner.orgId, hr.userId, "hr");
  await page.setViewportSize({ width: 390, height: 900 });
  await signInViaUi(page, hr.email, hr.password);

  await page.goto("/app/settings/holidays");
  await expect(page.getByRole("heading", { level: 1, name: "Holidays" })).toBeVisible();
  const add = page.getByRole("form", { name: "Add a holiday" });
  await add.getByLabel("Date").fill(`${year}-10-01`);
  await add.getByLabel("Name").fill("Independence Day");
  await add.getByRole("button", { name: "Add holiday" }).click();
  await expect(page.getByTestId("holiday-list")).toContainText("Independence Day");

  const week = page.getByRole("form", { name: "Working week" });
  await week.getByRole("checkbox", { name: "Sat" }).check();
  await week.getByRole("button", { name: "Save working week" }).click();
  await expect(week.getByRole("status")).toHaveText("Saved");
  await page.reload();
  await expect(page.getByText("working week Mon to Sat")).toBeVisible();
  await expectNoHorizontalScroll(page);
});
