import { randomUUID } from "node:crypto";

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

const NAV = { timeout: 15_000 };

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/**
 * A company (it gets its Head office with it), one client with a site and a project, and four
 * employees: HR, finance and the operations manager, who work at the office, and a guard.
 */
async function setUp(label: string) {
  const admin = adminClient();
  const suffix = uniqueSuffix();
  const owner = await createOwner(label, `Office Guarding ${suffix}`);
  const hr = await createAccount(`${label}-hr`, "Halima Bello");
  await addMembership(owner.orgId, hr.userId, "hr");
  const { data: client } = await admin
    .from("clients")
    .insert({ organisation_id: owner.orgId, name: `Coastline ${suffix}` })
    .select("id")
    .single();
  const { data: site } = await admin
    .from("sites")
    .insert({ organisation_id: owner.orgId, client_id: client!.id, name: `Apapa ${suffix}` })
    .select("id")
    .single();
  const { data: office } = await admin
    .from("sites")
    .select("id, name")
    .eq("organisation_id", owner.orgId)
    .eq("kind", "office")
    .single();
  const names = ["Halima HR", "Femi Finance", "Tunde Operations", "Ada Guard"].map(
    (n) => `${n}${suffix}`,
  );
  const ids = names.map(() => randomUUID());
  const { error } = await admin.from("workers").insert(
    names.map((name, i) => ({
      id: ids[i]!,
      organisation_id: owner.orgId,
      staff_id: `HO-${i + 1}-${suffix.slice(0, 4)}`,
      first_name: name.split(" ")[0]!,
      last_name: name.split(" ")[1]!,
      employment_type: "permanent" as const,
      start_date: "2025-01-06",
    })),
  );
  expect(error).toBeNull();
  // The guard works at the client's site; the office staff aren't mapped yet.
  const assigned = await admin.from("worker_assignments").insert({
    organisation_id: owner.orgId,
    worker_id: ids[3]!,
    site_id: site!.id,
    effective_from: "2025-01-06",
  });
  expect(assigned.error).toBeNull();
  return { owner, hr, office: office!, names, ids };
}

/**
 * Slice 6.11: HR ticks the HR, finance and operations staff on the People list, maps them to
 * Head office with "Map to site and project" (no projects offered for an office), and each
 * person's page shows "Head office · overhead", at 1440px.
 */
test("HR maps three office staff to Head office", async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { hr, office, names, ids } = await setUp("head-office");
  expect(office.name).toBe("Head office");

  await signInViaUi(page, hr.email, hr.password);
  await expect(page).toHaveURL(/\/app/, NAV);
  await page.goto("/app/people");
  const table = page.getByRole("table", { name: "Employees" });
  await expect(table.locator("tbody tr")).toHaveCount(4, NAV);

  for (const name of names.slice(0, 3)) {
    await page.getByRole("checkbox", { name: `Select ${name}` }).check();
  }
  const bar = page.getByRole("region", { name: "Bulk actions" });
  await expect(bar).toContainText("3 selected");

  await bar.getByRole("button", { name: "Map to site and project" }).click();
  const sheet = page.getByRole("dialog", { name: "Map to site and project" });
  const sitePicker = sheet.getByLabel("Site", { exact: true });
  // Head office comes first, labelled as overhead.
  await expect(sitePicker.locator("option").nth(1)).toHaveText("Head office · overhead");
  await sitePicker.selectOption(office.id);
  await expect(sheet.getByTestId("bulk-map-office-note")).toBeVisible();
  await expect(sheet.getByRole("checkbox")).toHaveCount(0);
  await sheet.getByRole("button", { name: "Preview" }).click();

  await expect(sheet.getByTestId("bulk-map-summary")).toHaveText(
    "Maps 3 people to Head office.",
    NAV,
  );
  const preview = sheet.getByRole("list", { name: "Mapping before and after" });
  await expect(preview.getByRole("listitem")).toHaveCount(3);
  await sheet.getByRole("button", { name: "Map 3 people" }).click();
  await expect(sheet).toBeHidden(NAV);
  await expect(page.getByText(/^Mapping saved for 3 people\./)).toBeVisible(NAV);

  for (const id of ids.slice(0, 3)) {
    await page.goto(`/app/people/${id}`);
    const job = page.getByRole("region", { name: "Job and mapping" });
    await expect(job.getByText("Head office · overhead", { exact: true })).toBeVisible(NAV);
  }
  // The guard wasn't selected and stays at the client's site.
  await page.goto(`/app/people/${ids[3]!}`);
  await expect(
    page.getByRole("region", { name: "Job and mapping" }).getByText("Head office · overhead"),
  ).toHaveCount(0, NAV);
});

/** Slice 6.11: Settings > Company > Head office, and the office's page, fit at 390px. */
test("the Head office card on a phone", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const { owner, office } = await setUp("head-office-phone");

  await signInViaUi(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/app$/, NAV);
  await page.goto("/app/settings/company");
  const card = page.getByTestId("head-office-card");
  await expect(card).toBeVisible(NAV);
  await card.scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("heading", { name: "Head office", level: 2, exact: true }),
  ).toBeVisible();
  const row = card.getByTestId("office-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Head office");
  await expect(row).toContainText("Needs details");
  await expect(row).toContainText("0 people");
  await expect(card.getByRole("link", { name: "Add a branch office" })).toBeVisible();
  await expectNoHorizontalScroll(page);

  await row.click();
  await expect(page).toHaveURL(new RegExp(`/app/settings/offices/${office.id}$`), NAV);
  await expect(
    page.getByRole("heading", { name: "Head office", level: 1, exact: true }),
  ).toBeVisible(NAV);
  await expect(page.getByTestId("site-needs-details")).toBeVisible();
  await expect(page.getByRole("form", { name: "Office details" })).toBeVisible();
  await expectNoHorizontalScroll(page);
});
