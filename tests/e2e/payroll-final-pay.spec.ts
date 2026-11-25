/**
 * Slice 5.9c in the browser.
 * 1. A leaver's final pay with typed items: Musa Ibrahim (₦120,000 a month, ₦60,000 basic) is made
 *    redundant with his last day on Monday 5 Oct 2026, on 8 days of annual leave a year (6 days for
 *    the 9 complete months of 2026, the owner's pre-fill). On his
 *    final-pay off-cycle run the owner adds pay in lieu of untaken leave, pre-filled as 6 days ×
 *    ₦3,000 basic daily rate = ₦18,000 (taxable, not pensionable), and a ₦60,000,000 redundancy
 *    payment, split into ₦50,000,000 exempt from PAYE and ₦10,000,000 taxable. Gross pay is the
 *    prorated salary ₦62,857.14 + ₦18,000 + ₦60,000,000 = ₦60,080,857.14.
 * 2. The holiday pay rate: Finance sets 1.5× from tomorrow in Settings > Payroll rules.
 * At 1440px, then 390px with no horizontal scroll.
 */
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { addDays, lagosToday } from "@/lib/dates";

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

/** The leaver, with an annual leave type of 8 days a year. */
async function seedLeaver(orgId: string): Promise<void> {
  const admin = adminClient();
  const { data: worker, error } = await admin
    .from("workers")
    .insert({
      organisation_id: orgId,
      staff_id: `FP-${randomUUID().slice(0, 6)}`,
      first_name: "Musa",
      last_name: "Ibrahim",
      employment_type: "permanent",
      start_date: "2025-01-06",
      end_date: "2026-10-05",
      tax_state: "Lagos",
      annual_rent_declared_kobo: 36_000_000,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const rate = await admin.from("pay_rates").insert({
    organisation_id: orgId,
    worker_id: worker.id,
    pay_type: "monthly",
    basic_kobo: 6_000_000,
    housing_kobo: 3_600_000,
    transport_kobo: 2_400_000,
    other_allowances_kobo: 0,
    effective_from: "2025-01-06",
  });
  if (rate.error) throw new Error(rate.error.message);
  const { data: type, error: typeError } = await admin
    .from("leave_types")
    .insert({ organisation_id: orgId, code: "annual", name: "Annual" })
    .select("id")
    .single();
  if (typeError) throw new Error(typeError.message);
  // 8 days a year: 8 × 9 complete months of 2026 ÷ 12 = 6 days, none taken (owner decision).
  const entitlement = await admin.from("leave_entitlements").insert({
    organisation_id: orgId,
    leave_type_id: type.id,
    effective_from: "2026-01-01",
    days_per_year: 8,
  });
  if (entitlement.error) throw new Error(entitlement.error.message);
}

test("a final pay takes pay in lieu of leave and a redundancy payment split at ₦50m", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await createOwner("pfp-owner", `Coastline Security ${uniqueSuffix()}`);
  await seedLeaver(owner.orgId);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await signInViaUi(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });
  await page.goto("/app/payroll");
  await page.getByTestId("new-off-cycle").locator("summary").click();
  const create = page.getByRole("form", { name: "New off-cycle run" });
  await create.getByLabel("Why off-cycle").selectOption("final_pay");
  await create.getByLabel("Pay period").selectOption("2026-09-20");
  await create.getByLabel("Pay date").fill("2026-10-16");
  await create.getByRole("checkbox", { name: /Musa Ibrahim/ }).check();
  await create.getByLabel("Reason").fill("Made redundant, last day 5 October");
  await create.getByRole("button", { name: "Preview the off-cycle run" }).click();
  await expect(create.getByTestId("run-preview")).toBeVisible({ timeout: 30_000 });
  await create.getByRole("button", { name: "Prepare the off-cycle run" }).click();
  await expect(page).toHaveURL(/\/app\/payroll\/[0-9a-f-]+\?step=earnings/, { timeout: 30_000 });
  const runPath = new URL(page.url()).pathname;
  await expect(page.getByTestId("off-cycle-earnings-hint")).toContainText(
    "are final-pay items above",
  );

  // Pay in lieu of untaken leave: pre-filled from the balance and the basic on the last day.
  const items = page.getByRole("form", { name: "Add a final-pay item" });
  await expect(items.getByLabel("Worker")).toContainText("Musa Ibrahim");
  await expect(items.getByLabel("Item")).toHaveValue("leave_in_lieu");
  await expect(items.getByLabel("Untaken leave days")).toHaveValue("6");
  await expect(items).toContainText(
    "8 days a year × 9 of 12 months, rounded down, less 0 taken in 2026 = 6 days.",
  );
  await expect(items.getByLabel("Amount (₦)")).toHaveValue("18000.00");
  await expect(items.getByTestId("final-pay-rule")).toContainText("Labour Act s.18(4)");
  await expect(items.getByLabel("Reason for the change")).toHaveCount(0);
  await items.getByLabel("Reason", { exact: true }).fill("Six annual leave days not taken");
  await items.getByRole("button", { name: "Preview" }).click();
  const leavePreview = items.getByTestId("run-preview");
  await expect(leavePreview).toContainText(
    "Adds pay in lieu of untaken leave of ₦18,000, taxable and not pensionable",
    { timeout: 30_000 },
  );
  await expect(leavePreview).toContainText("6 days at ₦3,000.00 a day");
  await items.getByRole("button", { name: "Add and recalculate" }).click();
  await expect(items.getByRole("status")).toContainText("Added and recalculated", {
    timeout: 30_000,
  });

  // Redundancy: ₦60,000,000, of which ₦50,000,000 exempt.
  await page.reload();
  const again = page.getByRole("form", { name: "Add a final-pay item" });
  await again.getByLabel("Item").selectOption("loss_of_office");
  await expect(again.getByLabel("Untaken leave days")).toHaveCount(0);
  await again.getByLabel("Amount (₦)").fill("60,000,000");
  await again
    .getByLabel("Reason", { exact: true })
    .fill("Redundancy settlement, letter of 1 October");
  await again.getByRole("button", { name: "Preview" }).click();
  const lossPreview = again.getByTestId("run-preview");
  await expect(lossPreview).toContainText(
    "Adds redundancy or loss-of-office compensation of ₦60,000,000, ₦50,000,000 of it exempt from PAYE",
    { timeout: 30_000 },
  );
  await expect(lossPreview).toContainText("Exempt from PAYE");
  await expect(lossPreview).toContainText("₦10,000,000");
  await again.getByRole("button", { name: "Add and recalculate" }).click();
  await expect(again.getByRole("status")).toContainText("Added and recalculated", {
    timeout: 30_000,
  });

  await page.reload();
  const table = page.getByRole("table", { name: "Earnings and changes" });
  await expect(table).toContainText("Pay in lieu of untaken leave, 6 days");
  await expect(table).toContainText("Redundancy or loss-of-office compensation, exempt part");
  await expect(table).toContainText("Redundancy or loss-of-office compensation, taxable part");
  await expect(table).toContainText("Final pay · exempt from PAYE, not pensionable");
  await expect(table).toContainText("₦50,000,000.00");
  await expect(table).toContainText("₦10,000,000.00");

  // Gross pay: prorated salary + leave in lieu + the whole redundancy payment.
  await page.goto(`${runPath}?step=gross-to-net`);
  await expect(page.getByTestId("gross-to-net-row").first()).toContainText("₦60,080,857", {
    timeout: 30_000,
  });

  // 390px: the earnings step and its form fit.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${runPath}?step=earnings`);
  await expect(page.getByRole("form", { name: "Add a final-pay item" })).toBeVisible();
  await expectNoHorizontalScroll(page);
});

// Slice 5.10 (owner decision, 25 Nov 2026): the owner and HR set the holiday pay rate; Finance
// reads it (this test was Finance's before).
test("HR sets the public holiday pay rate from tomorrow; Finance only reads it", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const owner = await createOwner("phol-owner", `Coastline Security ${uniqueSuffix()}`);
  const hr = await createAccount("phol-hr", "Oluwaseun Adeyemi");
  await addMembership(owner.orgId, hr.userId, "hr");
  const finance = await createAccount("phol-fin", "Adaeze Okafor");
  await addMembership(owner.orgId, finance.userId, "finance");
  const tomorrow = addDays(lagosToday(), 1);

  // Finance sees the rate but no form.
  const financeContext = await browser.newContext();
  const financePage = await financeContext.newPage();
  await signInViaUi(financePage, finance.email, finance.password);
  await expect(financePage).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });
  await financePage.goto("/app/settings/payroll");
  await expect(financePage.getByTestId("holiday-multiplier")).toContainText("1.0×");
  await expect(financePage.getByRole("form", { name: "Set the holiday pay rate" })).toHaveCount(0);
  await financeContext.close();

  await page.setViewportSize({ width: 1440, height: 1000 });
  await signInViaUi(page, hr.email, hr.password);
  await expect(page).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });
  await page.goto("/app/settings/payroll");
  const section = page.getByTestId("holiday-pay");
  await expect(section.getByTestId("holiday-multiplier")).toContainText("1.0× (the starting rule)");
  await expect(section.getByTestId("loss-of-office-cap")).toContainText("₦50,000,000");
  await expect(section).toContainText("Confirm it with an employment lawyer");

  const form = page.getByRole("form", { name: "Set the holiday pay rate" });
  await form
    .getByLabel("Extra pay for holiday work (× hourly rate, on top of normal pay)")
    .fill("1.5");
  await expect(form.getByTestId("holiday-worked")).toContainText(
    "At ₦750 an hour: ₦750 normal + ₦1,125 extra = ₦1,875 an hour.",
  );
  await form.getByLabel("From").fill(tomorrow);
  await form.getByLabel("Reason").fill("New guard contracts pay public holidays at 1.5 times");
  await form.getByRole("button", { name: "Preview" }).click();
  const preview = form.getByTestId("run-preview");
  await expect(preview).toContainText("extra pay of 1.5× the hourly rate", { timeout: 15_000 });
  await expect(preview).toContainText("1.0× → 1.5×");
  await form.getByRole("button", { name: "Save the rate" }).click();
  await expect(form.getByRole("status")).toContainText("Holiday pay rate saved", {
    timeout: 15_000,
  });
  await page.reload();
  await expect(page.getByTestId("holiday-pay")).toContainText("1.5× · New guard contracts");

  await page.setViewportSize({ width: 390, height: 900 });
  await page.reload();
  await expect(page.getByTestId("holiday-pay")).toBeVisible();
  await expectNoHorizontalScroll(page);
});
