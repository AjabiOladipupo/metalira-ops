import { expect, test, type Page, type TestInfo } from "@playwright/test";

import {
  NEEDS_SUPABASE,
  addMembership,
  createAccount,
  createOwner,
  signInViaUi,
  supabaseReady,
  uniqueSuffix,
} from "./helpers/auth";

/**
 * Slice 3.0: business type and module switches. A services business skips Employees and gets no
 * Roster, People or Payroll; turning Shifts off hides Roster and refuses it by direct URL with
 * "This part is switched off".
 */

test.skip(!supabaseReady, NEEDS_SUPABASE);

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** The labels in the manager menu: the sidebar on desktop, the menu sheet on phones. */
async function menuLabels(page: Page, testInfo: TestInfo): Promise<string[]> {
  if (testInfo.project.name === "mobile-390") {
    await page.getByRole("button", { name: "Open menu" }).click();
    const dialog = page.getByRole("dialog", { name: "Menu" });
    await expect(dialog.getByRole("link", { name: "Home", exact: true })).toBeVisible();
    const labels = await dialog
      .getByRole("navigation", { name: "Main" })
      .getByRole("link")
      .allInnerTexts();
    await page.keyboard.press("Escape");
    return labels.map((l) => l.trim());
  }
  const nav = page.getByRole("navigation", { name: "Main" }).filter({ visible: true });
  await expect(nav.getByRole("link", { name: "Home", exact: true })).toBeVisible();
  return (await nav.getByRole("link").allInnerTexts()).map((l) => l.trim());
}

const cont = (page: Page) => page.getByRole("button", { name: "Continue", exact: true });
const visible = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });

test("a services business skips Employees and has no Roster, People or Payroll", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const suffix = uniqueSuffix();
  const owner = await createOwner("services", `Studio ${suffix}`, { setupDone: false });
  await signInViaUi(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/app\/setup\/plan$/, { timeout: 15_000 });
  await page.getByRole("radio", { name: /^Business Clients/ }).check({ force: true });
  await page.getByRole("spinbutton", { name: "Workers you expect each month" }).fill("1");
  await cont(page).click();

  // Step 2 asks what the business does; services hides the pay fields.
  await expect(page).toHaveURL(/\/app\/setup\/business$/, { timeout: 15_000 });
  await expect(page.getByRole("group", { name: "What does your business do?" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Pay day" })).toBeVisible();
  await page
    .getByRole("radio", { name: /^We deliver services or projects to clients/ })
    .check({ force: true });
  await expect(page.getByRole("combobox", { name: "Pay day" })).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Registered business name" })
    .fill(`Studio ${suffix} Ltd`);
  await page.getByRole("textbox", { name: "Trading name" }).fill(`Studio ${suffix}`);
  await page
    .getByRole("combobox", { name: "Industry" })
    .selectOption({ label: "Digital services (design, software, marketing)" });
  await page.getByRole("combobox", { name: "Head office state" }).selectOption("Lagos");
  await expectNoHorizontalScroll(page);
  await cont(page).click();

  await expect(page).toHaveURL(/\/app\/setup\/invoices$/, { timeout: 30_000 });
  await expect(visible(page, "setup-progress")).toHaveText("2 of 4 done");
  // The rail lists four steps and Ready: no Employees.
  await expect(page.getByRole("list", { name: "Setup steps" }).getByRole("listitem")).toHaveCount(
    5,
  );
  await page.getByRole("textbox", { name: "Invoice email" }).fill(`billing-${suffix}@example.test`);
  await cont(page).click();

  await expect(page).toHaveURL(/\/app\/setup\/clients$/, { timeout: 15_000 });
  await expect(visible(page, "setup-progress")).toHaveText("3 of 4 done");
  // Continue on Clients finishes setup.
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page).toHaveURL(/\/app\/setup\/ready$/, { timeout: 15_000 });
  await expect(visible(page, "setup-progress")).toHaveText("4 of 4 done");
  await expect(page.getByRole("link", { name: "Add your people" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Add your clients" })).toBeVisible();

  // The Employees step is not part of this wizard.
  await page.goto("/app/setup/employees");
  await expect(page).toHaveURL(/\/app\/setup\/ready$/);

  await page.goto("/app");
  const labels = await menuLabels(page, testInfo);
  expect(labels).toEqual(expect.arrayContaining(["Home", "Clients", "Settings"]));
  for (const hidden of ["Roster", "Live attendance", "People", "Timesheets", "Payroll run"]) {
    expect(labels, hidden).not.toContain(hidden);
  }
  // Home never points at the parts that are off.
  await expect(page.getByRole("main")).not.toContainText(/shift|payroll/i);

  // A typed URL shows the switched-off page, with the way to turn it on for the owner.
  await page.goto("/app/payroll");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("This part is switched off");
  await expect(page.getByRole("link", { name: "Open Modules" })).toHaveAttribute(
    "href",
    "/app/settings/company#modules",
  );
  await expectNoHorizontalScroll(page);
});

test("turning Shifts off hides Roster and shows the switched-off page by direct URL", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const suffix = uniqueSuffix();
  const owner = await createOwner("modules", `Guards ${suffix}`);
  const ops = await createAccount("modules-ops", "Ops Manager");
  await addMembership(owner.orgId, ops.userId, "ops_manager");

  await signInViaUi(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });
  expect(await menuLabels(page, testInfo)).toContain("Roster");

  await page.goto("/app/settings/company#modules");
  const section = page.getByRole("region", { name: "Modules" });
  const shifts = section.getByRole("checkbox", { name: /^Shifts/ });
  await expect(shifts).toBeChecked();
  // People can't go off while Shifts and Payroll are on.
  await section.getByRole("checkbox", { name: /^People/ }).uncheck();
  await expect(section.getByText("Payroll needs People.", { exact: false })).toBeVisible();
  await expect(section.getByRole("button", { name: "Save modules" })).toBeDisabled();
  await section.getByRole("checkbox", { name: /^People/ }).check();

  await shifts.uncheck();
  await section.getByRole("button", { name: "Save modules" }).click();
  // The confirm step says nothing is deleted.
  const confirm = section.getByRole("alertdialog");
  await expect(confirm).toContainText("Turns off 1 part: Shifts.");
  await expect(confirm).toContainText("nothing is deleted");
  await expectNoHorizontalScroll(page);
  await confirm.getByRole("button", { name: "Turn it off" }).click();
  await expect(section.getByRole("checkbox", { name: /^Shifts/ })).not.toBeChecked({
    timeout: 15_000,
  });
  // The save remounts the form on the new switches (a busy local stack can take a while).
  await expect(section.getByRole("alertdialog")).toHaveCount(0, { timeout: 20_000 });

  await page.goto("/app");
  const labels = await menuLabels(page, testInfo);
  expect(labels).not.toContain("Roster");
  expect(labels).not.toContain("Live attendance");
  expect(labels).toContain("People");
  expect(labels).toContain("Payroll run");

  await page.goto("/app/roster");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("This part is switched off");
  await expect(page.getByRole("main")).toContainText("Shifts is off for your company.");
  await expect(page.getByRole("link", { name: "Open Modules" })).toBeVisible();

  // An ops manager sees the same page, without the link to the switches.
  await page.context().clearCookies();
  await signInViaUi(page, ops.email, ops.password);
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });
  await page.goto("/app/attendance");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("This part is switched off");
  await expect(page.getByText("Ask an owner or an admin to turn Shifts on.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Modules" })).toHaveCount(0);
});
