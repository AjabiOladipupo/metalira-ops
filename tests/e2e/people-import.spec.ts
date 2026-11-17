import { readFileSync } from "node:fs";
import path from "node:path";

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

const FIXTURE = path.join(process.cwd(), "fixtures", "people-import-162.csv");

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

const tile = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true });
const listed = (page: Page, row: number) =>
  page.getByTestId(`import-row-${row}`).filter({ visible: true });

/** The workers an import row became, read with the secret key (test-only). */
async function importedWorkers(orgId: string) {
  const admin = adminClient();
  const { data: batches } = await admin
    .from("import_batches")
    .select("id")
    .eq("organisation_id", orgId);
  const batchIds = (batches ?? []).map((b) => b.id);
  const { data: rows, error } = await admin
    .from("import_rows")
    .select(
      "row_number, workers ( id, staff_id, supervisor_clock_in, needs_pay_details, bank_account_last4, department_id, line_manager_worker_id )",
    )
    .in("batch_id", batchIds)
    .eq("status", "imported");
  if (error) throw new Error(error.message);
  return new Map((rows ?? []).map((r) => [r.row_number, r.workers]));
}

test("the 162-row file imports with its 4 problem rows held back and explained", async ({
  page,
}) => {
  // Two commits of up to 160 employees each, and several checks of the whole file.
  test.setTimeout(300_000);
  const owner = await createOwner("import", `Adebayo Facility ${uniqueSuffix()}`);
  await signInViaUi(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/app$/);

  await page.goto("/app/people/import");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Import employees");

  // The template downloads with the 32 columns.
  const templateDownload = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download template (.csv)" }).click();
  const template = await templateDownload;
  const templateText = readFileSync((await template.path())!, "utf8");
  expect(templateText.replace(/^﻿/, "").split("\r\n")[0]).toBe(
    readFileSync(
      path.join(process.cwd(), "fixtures", "employee_import_template.csv"),
      "utf8",
    ).split(/\r?\n/)[0],
  );

  // Upload: straight to Storage, then the server checks every row.
  await page.locator('input[type="file"][name="employees"]').setInputFiles(FIXTURE);
  await expect(page).toHaveURL(/\?batch=[0-9a-f-]{36}$/, { timeout: 60_000 });
  await expect(tile(page, "import-rows")).toHaveText("162");
  await expect(tile(page, "import-ready")).toHaveText("158");
  await expect(tile(page, "import-need-fixing")).toHaveText("4");
  await expect(tile(page, "import-found")).toHaveText(
    "4 departments · 14 line managers · 3 clients · 4 projects · 5 sites",
  );
  await expectNoHorizontalScroll(page);

  // The four rows from the Setup board, each with its reason.
  await expect(listed(page, 23)).toContainText(
    "Line manager ID MO-0090 is not in the file or in your account.",
  );
  await expect(listed(page, 57)).toContainText(
    "Bank account number has 9 digits; NUBAN numbers have 10.",
  );
  await expect(listed(page, 88)).toContainText("is also on row 12");
  await expect(listed(page, 88)).toContainText("Applied: Use supervisor clock-in");
  await expect(listed(page, 140)).toContainText('Client "Coastline Logistic" not found.');

  // The problems list downloads, one line per listed row.
  const problemsDownload = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download problems (.csv)" }).click();
  const problemsText = readFileSync((await (await problemsDownload).path())!, "utf8");
  const problemLines = problemsText.replace(/^﻿/, "").trimEnd().split("\r\n");
  expect(problemLines[0]).toBe("Row,Staff ID,Name,Status,Problem,Suggested fix");
  expect(problemLines.slice(1).map((line) => line.split(",")[0])).toEqual([
    "23",
    "57",
    "88",
    "140",
  ]);

  // Fix one more with one click: 160 ready.
  await listed(page, 140).getByRole("button", { name: "Match to Coastline Logistics" }).click();
  await expect(listed(page, 140)).toHaveCount(0, { timeout: 30_000 });
  await expect(tile(page, "import-need-fixing")).toHaveText("3");
  await page.getByRole("button", { name: "Import 160 employees" }).click();
  await expect(page.getByTestId("import-result").filter({ visible: true })).toContainText(
    "160 employees imported",
    { timeout: 60_000 },
  );
  await expect(tile(page, "import-need-fixing")).toHaveText("2");
  await expect(listed(page, 88)).toHaveCount(0);

  let workers = await importedWorkers(owner.orgId);
  expect(workers.size).toBe(160);
  expect(workers.get(88)?.supervisor_clock_in).toBe(true);
  expect(workers.get(12)?.supervisor_clock_in).toBe(false);
  // Mapped: department, line manager and site.
  const kola = workers.get(4);
  expect(kola?.staff_id).toBe("AFS-0003");
  expect(workers.get(24)?.line_manager_worker_id).toBeTruthy();
  expect(workers.get(140)?.department_id).toBeTruthy();

  // Then fix and import the rest.
  await listed(page, 23).getByRole("button", { name: "Set to Kola Adebayo" }).click();
  await expect(listed(page, 23)).toHaveCount(0, { timeout: 30_000 });
  await listed(page, 57).getByRole("button", { name: "Mark for HR to fix" }).click();
  await expect(listed(page, 57)).toHaveCount(0, { timeout: 30_000 });
  await expect(tile(page, "import-need-fixing")).toHaveText("0");
  await page.getByRole("button", { name: "Import 2 employees" }).click();
  await expect(page.getByTestId("import-result").filter({ visible: true })).toContainText(
    "162 employees imported",
    { timeout: 60_000 },
  );
  await expectNoHorizontalScroll(page);

  workers = await importedWorkers(owner.orgId);
  expect(workers.size).toBe(162);
  expect(workers.get(23)?.line_manager_worker_id).toBe(kola?.id);
  // Row 57 imported without the bad account number, flagged for pay details.
  expect(workers.get(57)?.bank_account_last4).toBeNull();
  expect(workers.get(57)?.needs_pay_details).toBe(true);

  // Audit: one event per commit, one fix event per one-click fix.
  const { data: events } = await adminClient()
    .from("audit_log")
    .select("action")
    .eq("organisation_id", owner.orgId)
    .in("action", ["people.import_committed", "people.import_row_fixed"]);
  const actions = (events ?? []).map((e) => e.action).sort();
  expect(actions).toEqual([
    "people.import_committed",
    "people.import_committed",
    "people.import_row_fixed",
    "people.import_row_fixed",
    "people.import_row_fixed",
  ]);
});

test("setup step 5 hosts the import", async ({ page }) => {
  test.setTimeout(120_000);
  const owner = await createOwner("import-setup", `Setup Import ${uniqueSuffix()}`, {
    setupDone: false,
  });
  await signInViaUi(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/app\/setup\//, { timeout: 15_000 });
  await page.goto("/app/setup/employees");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bring in your employees");
  await expect(page.getByRole("link", { name: "Download template (.csv)" })).toBeVisible();
  await page.locator('input[type="file"][name="employees"]').setInputFiles(FIXTURE);
  await expect(page).toHaveURL(/\/app\/setup\/employees\?batch=[0-9a-f-]{36}$/, {
    timeout: 60_000,
  });
  await expect(tile(page, "import-need-fixing")).toHaveText("4");
  await expect(page.getByRole("button", { name: "Import 159 employees" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Finish setup" })).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Cancelling goes back to the upload; nothing was imported.
  await page.getByRole("button", { name: "Cancel this import" }).click();
  await expect(page).toHaveURL(/\/app\/setup\/employees$/, { timeout: 15_000 });
  const { count } = await adminClient()
    .from("workers")
    .select("id", { count: "exact", head: true })
    .eq("organisation_id", owner.orgId);
  expect(count).toBe(0);
});

test("an ops manager can't open the import or download from it", async ({ page }) => {
  const owner = await createOwner("import-owner", `Ops Import ${uniqueSuffix()}`);
  const ops = await createAccount("import-ops", "Ops Manager");
  await addMembership(owner.orgId, ops.userId, "ops_manager");
  await signInViaUi(page, ops.email, ops.password);
  await expect(page).toHaveURL(/\/app$/);
  await page.goto("/app/people/import");
  await expect(page).toHaveURL(/\/no-access$/);
  const template = await page.request.get("/app/people/import/template");
  expect(template.status()).toBe(403);
  // The People page offers no import to this role.
  await page.goto("/app/people");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("People");
  await expect(page.getByRole("link", { name: "Import", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Invite", exact: true })).toHaveCount(0);
});
