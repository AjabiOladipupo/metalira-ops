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

function lagosToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
}

/**
 * Slice U.1: tick three employees on the People list, preview ending their employment (shifts,
 * leave and the final pay note per person), confirm, and they leave the active list, at 1440px.
 */
test("select three people and end their employment with a preview", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const suffix = uniqueSuffix();
  const owner = await createOwner("bulk-end", `Bulk Guarding ${suffix}`);
  const names = ["Ada", "Bayo", "Chika", "Dayo"].map((first) => `${first} Leaver${suffix}`);
  const ids = names.map(() => randomUUID());
  const { error } = await adminClient()
    .from("workers")
    .insert(
      names.map((name, i) => ({
        id: ids[i]!,
        organisation_id: owner.orgId,
        staff_id: `BE-${i + 1}-${suffix.slice(0, 4)}`,
        first_name: name.split(" ")[0]!,
        last_name: name.split(" ")[1]!,
        employment_type: "permanent" as const,
        start_date: "2025-01-06",
      })),
    );
  expect(error).toBeNull();

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

  await bar.getByRole("button", { name: "End employment" }).click();
  const sheet = page.getByRole("dialog", { name: "End employment" });
  await expect(sheet.getByLabel("Last working day")).toHaveValue(lagosToday());
  await sheet.getByLabel("Reason").fill("Client contract ended");
  await sheet.getByRole("button", { name: "Preview" }).click();

  await expect(sheet.getByTestId("bulk-end-summary")).toContainText(
    "Ends employment for 3 people on",
    NAV,
  );
  const preview = sheet.getByRole("list", { name: "What ending employment leaves" });
  await expect(preview.getByRole("listitem")).toHaveCount(3);
  await expect(preview.getByText("No future shifts")).toHaveCount(3);
  await expect(preview.getByText("Final pay will be prorated in the next payroll.")).toHaveCount(3);
  await expect(preview).not.toContainText(names[3]!);

  await sheet.getByRole("button", { name: "End employment for 3 people" }).click();
  await expect(sheet).toBeHidden(NAV);
  await expect(page.getByText(/^Employment ends on .* for 3 people\.$/)).toBeVisible(NAV);
  await expect(table.locator("tbody tr")).toHaveCount(1, NAV);
  await expect(table).toContainText(names[3]!);

  const { data } = await adminClient().from("workers").select("id, status, end_date").in("id", ids);
  const ended = (data ?? []).filter((w) => w.status === "ended").map((w) => w.id);
  expect(ended.sort()).toEqual(ids.slice(0, 3).sort());

  // Ended people are one filter away.
  await page.goto("/app/people?status=ended");
  await expect(page.getByRole("status").filter({ hasText: "found" })).toHaveText(
    "3 employees found",
    NAV,
  );
});

/**
 * Slice U.1: at 390px, filter the People list by site and line manager; the filters sit in the
 * URL and combine with AND, and "Clear filters" brings everyone back.
 */
test("filter the People list by site and line manager on a phone", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const admin = adminClient();
  const suffix = uniqueSuffix();
  const owner = await createOwner("bulk-filter", `Filter Cleaners ${suffix}`);
  const manager = await createAccount("bulk-filter-lm", `Funke Filter${suffix}`);
  await addMembership(owner.orgId, manager.userId, "line_manager");
  const { data: membership } = await admin
    .from("memberships")
    .select("id")
    .eq("organisation_id", owner.orgId)
    .eq("user_id", manager.userId)
    .single();
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
  const apapa = sites!.find((s) => s.name.startsWith("Apapa"))!.id;
  const lekki = sites!.find((s) => s.name.startsWith("Lekki"))!.id;

  const people = [
    { first: "Match", site: apapa, lm: true },
    { first: "Nolm", site: apapa, lm: false },
    { first: "Elsewhere", site: lekki, lm: true },
  ].map((p, i) => ({ ...p, id: randomUUID(), staff: `BF-${i + 1}-${suffix.slice(0, 4)}` }));
  const inserted = await admin.from("workers").insert(
    people.map((p) => ({
      id: p.id,
      organisation_id: owner.orgId,
      staff_id: p.staff,
      first_name: p.first,
      last_name: `Person${suffix}`,
      employment_type: "permanent" as const,
      start_date: "2025-01-06",
      line_manager_membership_id: p.lm ? membership!.id : null,
    })),
  );
  expect(inserted.error).toBeNull();
  const assigned = await admin.from("worker_assignments").insert(
    people.map((p) => ({
      organisation_id: owner.orgId,
      worker_id: p.id,
      site_id: p.site,
      effective_from: "2025-01-06",
    })),
  );
  expect(assigned.error).toBeNull();

  await signInViaUi(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/app$/, NAV);
  await page.goto("/app/people");
  const table = page.getByRole("table", { name: "Employees" });
  await expect(table.locator("tbody tr")).toHaveCount(3, NAV);

  // Closed on a phone, so the list stays above the fold.
  const toggle = page.getByRole("button", { name: "Filters", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  const form = page.getByRole("form", { name: "Filter employees" });
  await form.getByLabel("Site", { exact: true }).selectOption({ label: `Apapa ${suffix}` });
  await form
    .getByLabel("Line manager", { exact: true })
    .selectOption({ label: `Funke Filter${suffix}` });
  await expectNoHorizontalScroll(page);
  await form.getByRole("button", { name: "Apply filters" }).click();

  await expect(page).toHaveURL(new RegExp(`site=${apapa}`), NAV);
  await expect(page).toHaveURL(/manager=m%3A/);
  await expect(page.getByRole("status").filter({ hasText: "found" })).toHaveText(
    "1 employee found",
    NAV,
  );
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table).toContainText(`Match Person${suffix}`);
  await expect(page.getByRole("button", { name: "Filters (2)" })).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Ticking a row brings the action bar up from the bottom of the screen.
  await page.getByRole("checkbox", { name: `Select Match Person${suffix}` }).check();
  const bar = page.getByRole("region", { name: "Bulk actions" });
  await expect(bar).toContainText("1 selected");
  const box = await bar.boundingBox();
  expect(box!.y + box!.height).toBeGreaterThan(844 - 2);
  await expectNoHorizontalScroll(page);
  await bar.getByRole("button", { name: "Clear" }).click();
  await expect(bar).toBeHidden();

  await page.getByRole("link", { name: "Clear filters" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(3, NAV);
});
