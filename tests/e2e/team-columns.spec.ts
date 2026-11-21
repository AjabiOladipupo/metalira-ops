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

const CENTRE = "SRID=4326;POINT(3.3611 6.4474)";

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/**
 * Slice 4.0 acceptance: a line manager no longer reads public.workers (the Data API gives them
 * no row, so no bank_account_last4), and their pages look the same as before: the reportee's
 * page shows the name, job, department, line manager and site from public.my_reportees, and
 * someone who doesn't report to them is still not found.
 */
test("a line manager's pages still show their reportees, and the Data API shows no bank columns", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const admin = adminClient();
  const suffix = uniqueSuffix();
  const owner = await createOwner("cols-owner", `Apapa Guarding ${suffix}`);
  const manager = await createAccount("cols-lm", "Kola Adebayo");
  await addMembership(owner.orgId, manager.userId, "line_manager");
  const { data: membership } = await admin
    .from("memberships")
    .select("id")
    .eq("organisation_id", owner.orgId)
    .eq("user_id", manager.userId)
    .single();

  const { data: department } = await admin
    .from("departments")
    .insert({ organisation_id: owner.orgId, name: "Security services" })
    .select("id")
    .single();
  const { data: clientId, error: clientError } = await admin.rpc("create_client", {
    p_organisation_id: owner.orgId,
    p_name: "Coastline Logistics",
    p_contact_name: "Ngozi Eze",
    p_contact_email: "accounts@coastline.example",
  });
  expect(clientError).toBeNull();
  const site = await admin
    .from("sites")
    .insert({
      organisation_id: owner.orgId,
      client_id: clientId!,
      name: "Apapa Warehouse 3",
      centre: CENTRE,
    } as never)
    .select("id")
    .single();
  expect(site.error).toBeNull();

  const reporteeId = randomUUID();
  const strangerId = randomUUID();
  const inserted = await admin.from("workers").insert([
    {
      id: reporteeId,
      organisation_id: owner.orgId,
      staff_id: `TC-${suffix.slice(0, 4)}-R`,
      first_name: "Musa",
      last_name: `Ibrahim ${suffix}`,
      job_title: "Site guard",
      employment_type: "permanent",
      start_date: "2024-03-03",
      department_id: department!.id,
      line_manager_membership_id: membership!.id,
    },
    {
      id: strangerId,
      organisation_id: owner.orgId,
      staff_id: `TC-${suffix.slice(0, 4)}-S`,
      first_name: "Ada",
      last_name: `Stranger ${suffix}`,
      employment_type: "permanent",
      start_date: "2024-03-03",
    },
  ]);
  expect(inserted.error).toBeNull();
  const mapped = await admin.from("worker_assignments").insert({
    organisation_id: owner.orgId,
    worker_id: reporteeId,
    site_id: site.data!.id,
    effective_from: "2024-03-03",
  });
  expect(mapped.error).toBeNull();

  // The Data API, as the line manager: no worker rows at all, so no bank column.
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

    await page.goto(`/app/people/${reporteeId}`);
    await expect(page.getByRole("heading", { name: `Musa Ibrahim ${suffix}` })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(`Site guard · TC-${suffix.slice(0, 4)}-R`)).toBeVisible();
    await expect(page.getByText("Security services")).toBeVisible();
    await expect(page.getByText("Kola Adebayo").first()).toBeVisible();
    await expect(page.getByText("Apapa Warehouse 3")).toBeVisible();
    for (const section of ["Pay", "Bank details", "Tax and pension", "Next of kin"]) {
      await expect(page.getByRole("heading", { name: section, exact: true })).toHaveCount(0);
    }
    await expectNoHorizontalScroll(page);

    await page.goto(`/app/people/${strangerId}`);
    await expect(page.getByText("This page could not be found.")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(`Stranger ${suffix}`)).toHaveCount(0);
  }
});
