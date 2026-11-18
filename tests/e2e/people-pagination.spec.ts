import { expect, test, type Page } from "@playwright/test";

import { adminClient } from "../rls/helpers/supabase";
import {
  NEEDS_SUPABASE,
  createOwner,
  signInViaUi,
  supabaseReady,
  uniqueSuffix,
} from "./helpers/auth";

test.skip(!supabaseReady, NEEDS_SUPABASE);

const TOTAL = 60;
// Each page change is a server render; give it time on a cold dev server.
const NAV = { timeout: 15_000 };

async function seedWorkers(orgId: string, suffix: string) {
  const rows = Array.from({ length: TOTAL }, (_, i) => {
    const n = String(i + 1).padStart(3, "0");
    return {
      organisation_id: orgId,
      staff_id: `PG-${n}`,
      first_name: "Pager",
      last_name: `${n} ${suffix}`,
      job_title: "Security guard",
      employment_type: "permanent" as const,
      start_date: "2025-01-06",
    };
  });
  const { error } = await adminClient().from("workers").insert(rows);
  if (error) throw new Error(`Could not add workers: ${error.message}`);
}

const table = (page: Page) => page.getByRole("table", { name: "Employees" });
const bodyRows = (page: Page) => table(page).locator("tbody tr");
const range = (page: Page) => page.getByTestId("page-range");

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/**
 * People list: 25 rows a page by default, previous/next with a "1–25 of 60" count, a page size
 * remembered on the device and kept in the URL, search starting again on page 1, and a header
 * row that stays frozen while scrolling through the employees.
 */
test("People list pages through employees with a chosen page size and a frozen header", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const suffix = uniqueSuffix();
  const owner = await createOwner("people-pages", `Pager Guarding ${suffix}`);
  await seedWorkers(owner.orgId, suffix);

  await signInViaUi(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });

  // Default: 25 rows, page 1.
  await page.goto("/app/people");
  await expect(range(page)).toHaveText(`1–25 of ${TOTAL}`, NAV);
  await expect(bodyRows(page)).toHaveCount(25);
  await expect(bodyRows(page).first()).toContainText("Pager 001");
  const pages = page.getByRole("navigation", { name: "Employee pages" });
  await expect(pages.getByRole("button", { name: "Previous" })).toBeDisabled();
  await expectNoHorizontalScroll(page);

  // Next and previous.
  await pages.getByRole("link", { name: "Next" }).click();
  await expect(page).toHaveURL(/[?&]page=2(&|$)/, NAV);
  await expect(range(page)).toHaveText(`26–50 of ${TOTAL}`, NAV);
  await expect(bodyRows(page).first()).toContainText("Pager 026");
  await pages.getByRole("link", { name: "Next" }).click();
  await expect(range(page)).toHaveText(`51–60 of ${TOTAL}`, NAV);
  await expect(bodyRows(page)).toHaveCount(10);
  await expect(pages.getByRole("button", { name: "Next" })).toBeDisabled();
  await pages.getByRole("link", { name: "Previous" }).click();
  await expect(range(page)).toHaveText(`26–50 of ${TOTAL}`, NAV);

  // Page size: back to page 1 with 50 rows, in the URL.
  await page.getByRole("combobox", { name: "Rows per page" }).click();
  await page.getByRole("option", { name: "50" }).click();
  await expect(page).toHaveURL(/[?&]size=50(&|$)/, NAV);
  await expect(page).not.toHaveURL(/[?&]page=/, NAV);
  await expect(range(page)).toHaveText(`1–50 of ${TOTAL}`, NAV);
  await expect(bodyRows(page)).toHaveCount(50);

  // The header row stays in view while scrolling down through the employees.
  const frame = page.locator('[data-slot="data-table"]');
  await frame.scrollIntoViewIfNeeded();
  await frame.evaluate((el) => el.scrollIntoView({ block: "start" }));
  const header = table(page).locator("thead th").first();
  await frame.hover();
  await page.mouse.wheel(0, 1500);
  await expect
    .poll(() => frame.evaluate((el) => el.scrollTop), { timeout: 5_000 })
    .toBeGreaterThan(500);
  const headerBox = await header.boundingBox();
  const frameBox = await frame.boundingBox();
  const firstRowBox = await bodyRows(page).first().boundingBox();
  const viewport = page.viewportSize()!;
  expect(headerBox && frameBox && firstRowBox).toBeTruthy();
  expect(headerBox!.y).toBeGreaterThanOrEqual(0);
  expect(headerBox!.y + headerBox!.height).toBeLessThanOrEqual(viewport.height);
  expect(Math.abs(headerBox!.y - frameBox!.y)).toBeLessThanOrEqual(2);
  // The first employee has scrolled up under the header.
  expect(firstRowBox!.y).toBeLessThan(headerBox!.y);
  await expect(header).toBeInViewport();

  // The choice is remembered on this device when the URL has no size.
  await page.goto("/app/people");
  await expect(range(page)).toHaveText(`1–50 of ${TOTAL}`, NAV);
  await expect(page.getByRole("combobox", { name: "Rows per page" })).toHaveText("50");

  // A shared link wins over the remembered size.
  await page.goto("/app/people?size=25&page=3");
  await expect(range(page)).toHaveText(`51–60 of ${TOTAL}`, NAV);

  // Searching starts again on page 1 and keeps the size.
  await page.goto("/app/people?size=25&page=2");
  await page.getByRole("searchbox", { name: "Search by name or staff ID" }).fill("PG-05");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(/[?&]q=PG-05/, NAV);
  await expect(page).not.toHaveURL(/[?&]page=/, NAV);
  await expect(page.getByRole("status").filter({ hasText: "found" })).toHaveText(
    "10 employees found",
  );
  await expect(range(page)).toHaveText("1–10 of 10");
});
