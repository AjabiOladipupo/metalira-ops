import { randomUUID } from "node:crypto";

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

const NAV = { timeout: 15_000 };

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** An owner with one client, two sites, a project at the first site, and `count` guards. */
async function setUp(label: string, count: number) {
  const admin = adminClient();
  const suffix = uniqueSuffix();
  const owner = await createOwner(label, `Map Guarding ${suffix}`);
  const { data: client } = await admin
    .from("clients")
    .insert({ organisation_id: owner.orgId, name: `Coastline ${suffix}` })
    .select("id")
    .single();
  const { data: sites } = await admin
    .from("sites")
    .insert([
      { organisation_id: owner.orgId, client_id: client!.id, name: `Apapa ${suffix}` },
      { organisation_id: owner.orgId, client_id: client!.id, name: `Lekki ${suffix}` },
    ])
    .select("id, name");
  const apapa = sites!.find((s) => s.name.startsWith("Apapa"))!;
  const lekki = sites!.find((s) => s.name.startsWith("Lekki"))!;
  const { data: project } = await admin
    .from("projects")
    .insert({ organisation_id: owner.orgId, client_id: client!.id, name: `Night patrol ${suffix}` })
    .select("id, name")
    .single();
  const names = Array.from(
    { length: count },
    (_, i) => `${["Ada", "Bayo", "Chika", "Dayo"][i]!} Guard${suffix}`,
  );
  const ids = names.map(() => randomUUID());
  const { error } = await admin.from("workers").insert(
    names.map((name, i) => ({
      id: ids[i]!,
      organisation_id: owner.orgId,
      staff_id: `BM-${i + 1}-${suffix.slice(0, 4)}`,
      first_name: name.split(" ")[0]!,
      last_name: name.split(" ")[1]!,
      employment_type: "permanent" as const,
      start_date: "2025-01-06",
    })),
  );
  expect(error).toBeNull();
  // Everyone starts at Lekki, so Replace has something to close.
  const assigned = await admin.from("worker_assignments").insert(
    ids.map((id) => ({
      organisation_id: owner.orgId,
      worker_id: id,
      site_id: lekki.id,
      effective_from: "2025-01-06",
    })),
  );
  expect(assigned.error).toBeNull();
  return { owner, apapa, lekki, project: project!, names, ids };
}

/**
 * Slice U.3: tick three guards on the People list, map them to a site and project with Replace,
 * preview each person's site before and after, confirm, and each person's page shows the new
 * site and project, at 1440px.
 */
test("select three guards and map them to a site and project with Replace", async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { owner, apapa, lekki, project, names, ids } = await setUp("bulk-map", 4);

  await signInViaUi(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/app$/, NAV);
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
  await sheet.getByLabel("Site", { exact: true }).selectOption(apapa.id);
  await sheet.getByRole("checkbox", { name: new RegExp(project.name) }).check();
  await expect(sheet.getByRole("radio", { name: /^Replace/ })).toBeChecked();
  await sheet.getByRole("button", { name: "Preview" }).click();

  await expect(sheet.getByTestId("bulk-map-summary")).toHaveText(
    `Maps 3 people to ${apapa.name}.`,
    NAV,
  );
  const preview = sheet.getByRole("list", { name: "Mapping before and after" });
  await expect(preview.getByRole("listitem")).toHaveCount(3);
  await expect(preview.getByText(`Now: ${lekki.name}; No projects`)).toHaveCount(3);
  await expect(preview.getByText(`After: ${apapa.name}; ${project.name}`)).toHaveCount(3);
  await expect(preview.getByText(/^From \d{1,2} [A-Z][a-z]{2} \d{4}$/)).toHaveCount(3);
  await expect(preview).not.toContainText(names[3]!);

  await sheet.getByRole("button", { name: "Map 3 people" }).click();
  await expect(sheet).toBeHidden(NAV);
  await expect(page.getByText(/^Mapping saved for 3 people\./)).toBeVisible(NAV);

  for (const id of ids.slice(0, 3)) {
    await page.goto(`/app/people/${id}`);
    const job = page.getByRole("region", { name: "Job and mapping" });
    await expect(job.getByText(apapa.name, { exact: true })).toBeVisible(NAV);
    await expect(job.getByText(project.name, { exact: true })).toBeVisible();
  }
  // The fourth guard wasn't selected and stays at Lekki.
  await page.goto(`/app/people/${ids[3]!}`);
  await expect(
    page.getByRole("region", { name: "Job and mapping" }).getByText(lekki.name, { exact: true }),
  ).toBeVisible(NAV);
});

/** Slice U.3: the mapping sheet opens and fits at 390px. */
test("open the mapping sheet on a phone", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const { owner, apapa, names } = await setUp("bulk-map-phone", 2);

  await signInViaUi(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/app$/, NAV);
  await page.goto("/app/people");
  await page.getByRole("checkbox", { name: `Select ${names[0]!}` }).check();
  const bar = page.getByRole("region", { name: "Bulk actions" });
  await bar.getByRole("button", { name: "Map to site and project" }).click();
  const sheet = page.getByRole("dialog", { name: "Map to site and project" });
  await expect(sheet.getByLabel("Site", { exact: true })).toBeVisible(NAV);
  await sheet.getByLabel("Site", { exact: true }).selectOption(apapa.id);
  await expect(sheet.getByRole("radio", { name: /^Add/ })).toBeVisible();
  await sheet.getByRole("button", { name: "Preview" }).click();
  await expect(sheet.getByTestId("bulk-map-summary")).toHaveText(
    `Maps 1 person to ${apapa.name}.`,
    NAV,
  );
  await expectNoHorizontalScroll(page);
  const box = await sheet.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
});
