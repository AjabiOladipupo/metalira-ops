import { expect, test, type Browser, type Page } from "@playwright/test";

import { addDays, firstOfNextMonth, formatDate, lagosToday } from "../../src/lib/dates";
import { adminClient } from "../rls/helpers/supabase";
import {
  NEEDS_SUPABASE,
  addMembership,
  createAccount,
  createOwner,
  signInViaUi,
  supabaseReady,
  uniqueSuffix,
  type TestAccount,
} from "./helpers/auth";

test.skip(!supabaseReady, NEEDS_SUPABASE);
// Bank details, NIN and RSA PIN are encrypted by the app, so the server under test needs a key.
// CI sets a fixed dummy key for the e2e job; locally, run with any 32-byte base64 key set.
test.skip(
  !process.env.PII_ENCRYPTION_KEY,
  "Needs PII_ENCRYPTION_KEY set for the app under test (any throwaway 32-byte base64 key)",
);

const NUBAN = "0123457712";
const NIN = "12345678901";

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function signedInPage(browser: Browser, account: TestAccount): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInViaUi(page, account.email, account.password);
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });
  return page;
}

/**
 * Slice 1.5 acceptance: HR adds a department and a worker, changes pay from next month and sees
 * two dated versions; ops_manager sees masked bank details and no edit controls; a line manager
 * (even the worker's own) cannot open the edit form.
 */
test("HR adds an employee and changes pay; other roles see masked, read-only views", async ({
  browser,
}) => {
  // Four sign-ins and a dozen server round trips.
  test.setTimeout(180_000);
  const suffix = uniqueSuffix();
  const owner = await createOwner("people-owner", `Kola Guarding ${suffix}`);
  const hr = await createAccount("people-hr", "Hauwa Bello");
  const ops = await createAccount("people-ops", "Obinna Okafor");
  const lm = await createAccount("people-lm", "Kola Adebayo");
  await addMembership(owner.orgId, hr.userId, "hr");
  await addMembership(owner.orgId, ops.userId, "ops_manager");
  await addMembership(owner.orgId, lm.userId, "line_manager");

  const today = lagosToday();
  const nextMonth = firstOfNextMonth(today);
  const firstName = "Musa";
  const lastName = `Ibrahim ${suffix}`;
  const name = `${firstName} ${lastName}`;

  // --- HR: empty People list, then a department -------------------------------------------
  const page = await signedInPage(browser, hr);
  await page.goto("/app/people");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("People");
  await expect(page.locator('[data-illustration="import-people"]')).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.goto("/app/settings/departments");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Departments");
  const addDepartment = page.getByRole("form", { name: "Add department" });
  await addDepartment.getByLabel("New department", { exact: true }).fill("Security services");
  await addDepartment.getByRole("button", { name: "Add department" }).click();
  await expect(page.getByText("Security services added.")).toBeVisible({ timeout: 15_000 });
  await expectNoHorizontalScroll(page);

  // --- HR: add an employee ----------------------------------------------------------------
  await page.goto("/app/people/new");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add employee");
  const form = page.getByRole("form", { name: "Add employee" });
  await form.getByLabel("First name", { exact: true }).fill(firstName);
  await form.getByLabel("Last name", { exact: true }).fill(lastName);
  await form.getByLabel("Phone", { exact: true }).fill("0803 555 0114");
  await form.getByLabel("Job title", { exact: true }).fill("Security guard");
  await form.getByLabel("Department", { exact: true }).selectOption({ label: "Security services" });
  await form
    .getByLabel("Line manager", { exact: true })
    .selectOption({ label: "Kola Adebayo · Line manager" });
  await expect(form.getByLabel("Start date", { exact: true })).toHaveValue(today);
  await form.getByLabel("Pay type", { exact: true }).selectOption("monthly");
  await form.getByLabel("Basic monthly", { exact: true }).fill("150,000");
  await form.getByLabel("Housing monthly", { exact: true }).fill("50000");
  await form.getByLabel("Bank name", { exact: true }).fill("GTBank");
  await form.getByLabel("Account name", { exact: true }).fill(name);
  await form.getByLabel("Account number", { exact: true }).fill(NUBAN);
  await form.getByLabel("NIN", { exact: true }).fill(NIN);
  await expectNoHorizontalScroll(page);
  await form.getByRole("button", { name: "Add employee" }).click();

  await expect(page).toHaveURL(/\/app\/people\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  const workerId = page.url().split("/").at(-1)!;
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
  await expect(page.getByTestId("current-pay")).toHaveText("₦200,000.00 a month");
  await expect(page.getByTestId("bank-account")).toHaveText("••••7712");
  await expectNoHorizontalScroll(page);

  // HR may see the account number in full; the reveal is audited.
  await page.getByRole("button", { name: "Show account number" }).click();
  await expect(page.getByTestId("bank-account")).toHaveText(NUBAN, { timeout: 15_000 });

  // --- HR: change pay from next month -----------------------------------------------------
  const payForm = page.getByRole("form", { name: "Change pay" });
  await expect(payForm.getByLabel("Applies from", { exact: true })).toHaveValue(nextMonth);
  await payForm.getByLabel("Basic monthly", { exact: true }).fill("180,000");
  await payForm.getByRole("button", { name: "Save pay change" }).click();
  await expect(
    page.getByText(`Pay change saved. It applies from ${formatDate(nextMonth)}.`),
  ).toBeVisible({ timeout: 15_000 });

  const history = page.getByRole("table", { name: "Pay history" });
  await expect(history.locator("tbody tr")).toHaveCount(2);
  const scheduled = history.locator("tbody tr").nth(0);
  const current = history.locator("tbody tr").nth(1);
  await expect(scheduled).toContainText(formatDate(nextMonth));
  await expect(scheduled).toContainText("₦230,000.00 a month");
  await expect(scheduled).toContainText("Scheduled");
  await expect(current).toContainText(formatDate(today));
  await expect(current).toContainText(formatDate(addDays(nextMonth, -1)));
  await expect(current).toContainText("₦200,000.00 a month");
  await expect(current).toContainText("Current");
  await expectNoHorizontalScroll(page);

  // --- HR: the list shows the employee, their department and mapping status ---------------
  await page.goto("/app/people");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "1 employee · 1 not fully mapped",
  );
  const departments = page.getByRole("navigation", { name: "Departments" });
  await expect(departments.getByRole("link", { name: /Security services/ })).toContainText("1");
  const row = page.getByRole("row", { name: new RegExp(name) });
  await expect(row).toContainText("Security services");
  await expect(row).toContainText("Kola Adebayo");
  await expect(row).toContainText("Incomplete");
  await expectNoHorizontalScroll(page);

  const search = page.getByRole("searchbox", { name: "Search by name or staff ID" });
  await search.fill("nobody by this name");
  await search.press("Enter");
  await expect(page.getByText("No employees match.")).toBeVisible();
  await search.fill(suffix);
  await search.press("Enter");
  await expect(page.getByRole("row", { name: new RegExp(name) })).toBeVisible();

  // --- HR: edit details -------------------------------------------------------------------
  await page.goto(`/app/people/${workerId}/edit`);
  const edit = page.getByRole("form", { name: "Edit employee" });
  await expect(edit.getByLabel("Account number", { exact: true })).toHaveCount(0);
  await expect(edit.getByLabel("NIN", { exact: true })).toHaveValue("");
  await edit.getByLabel("Job title", { exact: true }).fill("Senior security guard");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/people/${workerId}$`), { timeout: 15_000 });
  await expect(page.getByText("Senior security guard ·")).toBeVisible();
  await page.context().close();

  // The audit log has the worker's rows, with no personal data in clear.
  const { data: audit, error } = await adminClient()
    .from("audit_log")
    .select("action, before, after")
    .eq("organisation_id", owner.orgId)
    .eq("entity_id", workerId);
  expect(error).toBeNull();
  const actions = (audit ?? []).map((r) => r.action);
  expect(actions).toEqual(
    expect.arrayContaining(["workers.insert", "workers.update", "pii.reveal"]),
  );
  const auditText = JSON.stringify(audit);
  expect(auditText).not.toContain(NUBAN);
  expect(auditText).not.toContain(NIN);

  // --- ops_manager: masked bank details, no edit controls ---------------------------------
  const opsPage = await signedInPage(browser, ops);
  await opsPage.goto(`/app/people/${workerId}`);
  await expect(opsPage.getByRole("heading", { level: 1 })).toHaveText(name);
  await expect(opsPage.getByTestId("bank-account")).toHaveText("••••7712");
  await expect(opsPage.getByRole("button", { name: "Show account number" })).toHaveCount(0);
  await expect(opsPage.getByRole("link", { name: "Edit details" })).toHaveCount(0);
  await expect(opsPage.getByRole("form", { name: "Change pay" })).toHaveCount(0);
  await expect(opsPage.getByText("Personal data is masked for your role.")).toBeVisible();
  await opsPage.goto(`/app/people/${workerId}/edit`);
  await expect(opsPage).toHaveURL(/\/no-access$/, { timeout: 15_000 });
  await opsPage.context().close();

  // --- line manager (the worker's own): no edit form, no People list ----------------------
  const lmPage = await signedInPage(browser, lm);
  await lmPage.goto(`/app/people/${workerId}/edit`);
  await expect(lmPage).toHaveURL(/\/no-access$/, { timeout: 15_000 });
  await lmPage.goto("/app/people");
  await expect(lmPage).toHaveURL(/\/no-access$/, { timeout: 15_000 });
  await lmPage.context().close();
});
