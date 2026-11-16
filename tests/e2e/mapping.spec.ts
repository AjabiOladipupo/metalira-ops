import { expect, test, type Page } from "@playwright/test";

import { addDays, formatDate, lagosToday } from "../../src/lib/dates";
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

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

function must<R extends { data: unknown; error: { message: string } | null }>(
  result: R,
): NonNullable<R["data"]> {
  if (result.error || result.data === null || result.data === undefined) {
    throw new Error(`Seeding failed: ${result.error?.message ?? "no data"}`);
  }
  return result.data as NonNullable<R["data"]>;
}

/** On phones the panel is a bottom sheet over the list; close it to get back to the table. */
async function closeSheetOnPhone(page: Page) {
  const sheet = page.getByRole("dialog");
  if (await sheet.isVisible()) {
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toBeHidden();
    await expect(page).not.toHaveURL(/map=/);
  }
}

/**
 * Slice 1.6 acceptance: HR maps an unmapped employee (a worker as line manager, a site and a
 * project) and the Incomplete count drops; remapping another employee to a new site keeps the
 * old assignment with an end date; the audit log has the mapping before and after.
 */
test("HR maps and remaps employees from the People list", async ({ browser }) => {
  test.setTimeout(150_000);
  const admin = adminClient();
  const suffix = uniqueSuffix();
  const owner = await createOwner("map-owner", `Coastline Guarding ${suffix}`);
  const hr = await createAccount("map-hr", "Hauwa Bello");
  const lm = await createAccount("map-lm", "Kola Adebayo");
  await addMembership(owner.orgId, hr.userId, "hr");
  await addMembership(owner.orgId, lm.userId, "line_manager");
  const lmMembership = must(
    await admin
      .from("memberships")
      .select("id")
      .eq("organisation_id", owner.orgId)
      .eq("user_id", lm.userId)
      .single(),
  );

  const org = owner.orgId;
  const department = must(
    await admin
      .from("departments")
      .insert({ organisation_id: org, name: "Security services" })
      .select("id")
      .single(),
  );
  const client = must(
    await admin
      .from("clients")
      .insert({ organisation_id: org, name: "Coastline Logistics" })
      .select("id")
      .single(),
  );
  const sites = must(
    await admin
      .from("sites")
      .insert([
        { organisation_id: org, client_id: client.id, name: "Apapa Warehouse 3" },
        { organisation_id: org, client_id: client.id, name: "Lekki Estate Gate B" },
      ])
      .select("id, name"),
  );
  const apapa = sites.find((s) => s.name === "Apapa Warehouse 3")!.id;
  const lekki = sites.find((s) => s.name === "Lekki Estate Gate B")!.id;
  must(
    await admin
      .from("projects")
      .insert({ organisation_id: org, client_id: client.id, name: "Coastline guarding contract" })
      .select("id"),
  );

  const musa = { first: "Musa", last: `Ibrahim ${suffix}`, staffId: "MO-0114" };
  const kunle = { first: "Kunle", last: `Ade ${suffix}`, staffId: "MO-0201" };
  const musaName = `${musa.first} ${musa.last}`;
  const kunleName = `${kunle.first} ${kunle.last}`;
  const workers = must(
    await admin
      .from("workers")
      .insert([
        {
          organisation_id: org,
          staff_id: musa.staffId,
          first_name: musa.first,
          last_name: musa.last,
          job_title: "Security guard",
          employment_type: "permanent",
          start_date: "2025-01-06",
          department_id: department.id,
          line_manager_membership_id: lmMembership.id,
        },
        {
          organisation_id: org,
          staff_id: kunle.staffId,
          first_name: kunle.first,
          last_name: kunle.last,
          job_title: "Relief guard",
          employment_type: "permanent",
          start_date: "2025-01-06",
        },
      ])
      .select("id, staff_id"),
  );
  const musaId = workers.find((w) => w.staff_id === musa.staffId)!.id;
  const kunleId = workers.find((w) => w.staff_id === kunle.staffId)!.id;
  // Musa has been on Apapa since he started (as an import would leave him): fully mapped.
  must(
    await admin
      .from("worker_assignments")
      .insert({
        organisation_id: org,
        worker_id: musaId,
        site_id: apapa,
        effective_from: "2025-01-06",
      })
      .select("id"),
  );

  const today = lagosToday();
  const tomorrow = addDays(today, 1);
  const savedFromTomorrow = `Saved. Site and project changes apply from ${formatDate(tomorrow)}.`;

  const context = await browser.newContext();
  const page = await context.newPage();
  await signInViaUi(page, hr.email, hr.password);
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });

  // --- The list: one of two employees still to map ---------------------------------------
  await page.goto("/app/people");
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText("2 employees · 1 not fully mapped");
  const kunleRow = page.getByRole("row", { name: new RegExp(kunle.staffId) });
  await expect(kunleRow).toContainText("Incomplete");
  await expectNoHorizontalScroll(page);

  // --- Map Kunle: department, a worker as line manager, a site and a project ------------
  await kunleRow.getByRole("link", { name: /change mapping for/ }).click();
  await expect(page).toHaveURL(new RegExp(`map=${kunleId}`));
  const kunleForm = page.getByRole("form", { name: kunleName });
  await expect(kunleForm).toBeVisible();
  await expectNoHorizontalScroll(page);
  await kunleForm
    .getByLabel("Department", { exact: true })
    .selectOption({ label: "Security services" });
  await kunleForm
    .getByLabel("Line manager", { exact: true })
    .selectOption({ label: `${musaName} · ${musa.staffId}` });
  await kunleForm
    .getByLabel("Site", { exact: true })
    .selectOption({ label: "Lekki Estate Gate B · Coastline Logistics" });
  await kunleForm.getByLabel("Coastline guarding contract · Coastline Logistics").check();
  await kunleForm.getByRole("button", { name: "Save mapping" }).click();
  await expect(kunleForm.getByRole("status")).toHaveText(savedFromTomorrow, { timeout: 15_000 });

  // The status flips and the Incomplete count drops at once.
  await expect(heading).toHaveText("2 employees · all mapped");
  await closeSheetOnPhone(page);
  await expect(kunleRow).toContainText("Mapped");
  await expect(kunleRow).toContainText(musaName);
  await expect(kunleRow).toContainText("Lekki Estate Gate B");
  await expect(kunleRow).toContainText("Coastline guarding contract");

  // --- Remap Musa from Apapa to Lekki --------------------------------------------------
  const musaRow = page.getByRole("row", { name: new RegExp(musa.staffId) });
  await musaRow.getByRole("link", { name: /change mapping for/ }).click();
  const musaForm = page.getByRole("form", { name: musaName });
  await expect(musaForm.getByLabel("Site", { exact: true })).toHaveValue(apapa);
  await expect(musaForm.getByLabel("Line manager", { exact: true })).toHaveValue(
    `m:${lmMembership.id}`,
  );
  await musaForm
    .getByLabel("Site", { exact: true })
    .selectOption({ label: "Lekki Estate Gate B · Coastline Logistics" });
  await musaForm.getByRole("button", { name: "Save mapping" }).click();
  await expect(musaForm.getByRole("status")).toHaveText(savedFromTomorrow, { timeout: 15_000 });
  await closeSheetOnPhone(page);
  await expect(musaRow).toContainText("Lekki Estate Gate B");
  await expect(musaRow).not.toContainText("Apapa Warehouse 3");
  await context.close();

  // The old assignment is kept with an end date; the new one starts tomorrow.
  const rows = must(
    await admin
      .from("worker_assignments")
      .select("site_id, effective_from, effective_to")
      .eq("worker_id", musaId)
      .order("effective_from"),
  );
  expect(rows).toEqual([
    { site_id: apapa, effective_from: "2025-01-06", effective_to: today },
    { site_id: lekki, effective_from: tomorrow, effective_to: null },
  ]);

  // The audit log shows the mapping before and after.
  const audit = must(
    await admin
      .from("audit_log")
      .select("before, after")
      .eq("organisation_id", org)
      .eq("entity_id", musaId)
      .eq("action", "people.mapping_saved"),
  );
  expect(audit).toHaveLength(1);
  expect(audit[0]?.before).toMatchObject({ sites: [{ id: apapa, name: "Apapa Warehouse 3" }] });
  expect(audit[0]?.after).toMatchObject({
    sites: [{ id: lekki, name: "Lekki Estate Gate B" }],
    assignmentsFrom: tomorrow,
  });
});
