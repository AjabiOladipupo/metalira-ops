import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { adminClient, anonClient } from "../rls/helpers/supabase";
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

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/**
 * Slice 4.0b acceptance (owner, 21 Nov 2026): a line manager gets the People list, showing only
 * the people assigned to them, with safe columns and no Add, Import or Invite. Someone who
 * doesn't report to them is not listed, and the Data API still gives them no worker rows.
 */
test("a line manager's People list shows only their reportees", async ({ page }) => {
  test.setTimeout(120_000);
  const admin = adminClient();
  const suffix = uniqueSuffix();
  const owner = await createOwner("lmp-owner", `Ikeja Cleaners ${suffix}`);
  const manager = await createAccount("lmp-lm", "Funke Adeyemi");
  const lonely = await createAccount("lmp-lonely", "Tunde Bakare");
  await addMembership(owner.orgId, manager.userId, "line_manager");
  await addMembership(owner.orgId, lonely.userId, "line_manager");
  const { data: membership } = await admin
    .from("memberships")
    .select("id")
    .eq("organisation_id", owner.orgId)
    .eq("user_id", manager.userId)
    .single();
  const { data: department } = await admin
    .from("departments")
    .insert({ organisation_id: owner.orgId, name: "Cleaning crew" })
    .select("id")
    .single();

  const staff = suffix.slice(0, 4);
  const inserted = await admin.from("workers").insert([
    {
      id: randomUUID(),
      organisation_id: owner.orgId,
      staff_id: `LP-${staff}-R`,
      first_name: "Chioma",
      last_name: `Okeke ${suffix}`,
      job_title: "Cleaner",
      phone: "08035550199",
      email: `chioma-${suffix}@example.test`,
      employment_type: "permanent",
      start_date: "2024-05-06",
      department_id: department!.id,
      line_manager_membership_id: membership!.id,
    },
    {
      id: randomUUID(),
      organisation_id: owner.orgId,
      staff_id: `LP-${staff}-S`,
      first_name: "Emeka",
      last_name: `Stranger ${suffix}`,
      employment_type: "permanent",
      start_date: "2024-05-06",
    },
  ]);
  expect(inserted.error).toBeNull();

  // The Data API, as the line manager: still no worker rows, so no bank column.
  const api = anonClient();
  expect(
    (await api.auth.signInWithPassword({ email: manager.email, password: manager.password })).error,
  ).toBeNull();
  const direct = await api.from("workers").select("bank_account_last4");
  expect(direct.error).toBeNull();
  expect(direct.data).toEqual([]);

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    if (viewport.width === 390) {
      await signInViaUi(page, manager.email, manager.password);
      await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });
    }

    await page.goto("/app/people");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "1 person reports to you · 1 active",
      { timeout: 15_000 },
    );
    const table = page.getByRole("region", { name: "Employees table" });
    await expect(
      table.getByRole("link", { name: new RegExp(`Chioma Okeke ${suffix}`) }),
    ).toBeVisible();
    await expect(table.getByText(`Cleaner · LP-${staff}-R`)).toBeVisible();
    await expect(table.getByText("Cleaning crew")).toBeVisible();
    await expect(table.getByText("08035550199")).toBeVisible();
    await expect(table.getByText(`chioma-${suffix}@example.test`)).toBeVisible();
    await expect(page.getByText(`Stranger ${suffix}`)).toHaveCount(0);
    for (const action of ["Add employee", "Import", "Invite"]) {
      await expect(page.getByRole("link", { name: action, exact: true })).toHaveCount(0);
    }
    for (const header of ["Line manager", "Projects", "Mapping"]) {
      await expect(table.getByRole("columnheader", { name: header, exact: true })).toHaveCount(0);
    }
    await expectNoHorizontalScroll(page);

    // Searching for the stranger finds no one.
    await page.goto(`/app/people?q=${encodeURIComponent(`Stranger ${suffix}`)}`);
    await expect(page.getByText("No employees match.")).toBeVisible({ timeout: 15_000 });

    // The pages that change data stay closed.
    await page.goto("/app/people/new");
    await expect(page).toHaveURL(/\/no-access$/, { timeout: 15_000 });
    await page.goto("/app/people/import");
    await expect(page).toHaveURL(/\/no-access$/, { timeout: 15_000 });
  }

  // A line manager with no reportees sees the empty state.
  const other = await page.context().browser()!.newContext();
  const lonelyPage = await other.newPage();
  await signInViaUi(lonelyPage, lonely.email, lonely.password);
  await expect(lonelyPage).toHaveURL(/\/app$/, { timeout: 15_000 });
  await lonelyPage.goto("/app/people");
  await expect(lonelyPage.getByText("No one reports to you yet.")).toBeVisible({ timeout: 15_000 });
  await other.close();
});
