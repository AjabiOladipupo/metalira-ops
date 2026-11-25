/**
 * Slice 5.7b in the browser: HR (here the owner) runs an off-cycle final pay for a leaver end to
 * end through approval. Musa Ibrahim (₦120,000 a month, golden split, rent ₦360,000) leaves on
 * Monday 5 Oct 2026, so the October 2026 period (20 Sep to 19 Oct) pays 11 of 21 rostered days:
 * ₦62,857.14 gross. A one-off leave encashment of ₦10,000 is added with a reason (the app has no
 * rule for it yet). Pension 8% of the prorated salary is ₦5,028.57 and PAYE is ₦0 (under the nil
 * band), so net pay is ₦67,828.57. The preparer can't approve it; Finance does, and the run shows
 * as posted without locking the period. At 1440px, then 390px with no horizontal scroll.
 */
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { adminClient } from "../rls/helpers/supabase";
import { giveRuleSetV1 } from "../rls/helpers/rule-sets";
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

/** The leaver, and a colleague who stays (so the picker has a choice). */
async function seedWorkers(orgId: string): Promise<void> {
  const admin = adminClient();
  for (const w of [
    { first: "Musa", last: "Ibrahim", end: "2026-10-05" },
    { first: "Grace", last: "Edet", end: null },
  ]) {
    const { data, error } = await admin
      .from("workers")
      .insert({
        organisation_id: orgId,
        staff_id: `OC-${randomUUID().slice(0, 6)}`,
        first_name: w.first,
        last_name: w.last,
        employment_type: "permanent",
        start_date: "2025-01-06",
        end_date: w.end,
        tax_state: "Lagos",
        annual_rent_declared_kobo: 36_000_000,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const rate = await admin.from("pay_rates").insert({
      organisation_id: orgId,
      worker_id: data.id,
      pay_type: "monthly",
      basic_kobo: 6_000_000,
      housing_kobo: 3_600_000,
      transport_kobo: 2_400_000,
      other_allowances_kobo: 0,
      effective_from: "2025-01-06",
    });
    if (rate.error) throw new Error(rate.error.message);
  }
}

async function goToStep(page: Page, label: RegExp, step: string) {
  await page.getByRole("link", { name: label }).first().click();
  await expect(page).toHaveURL(new RegExp(`step=${step}`));
}

test("an off-cycle final pay goes from the worker picker to Finance's approval", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const owner = await createOwner("poff-owner", `Coastline Security ${uniqueSuffix()}`);
  const finance = await createAccount("poff-fin", "Adaeze Okafor");
  await addMembership(owner.orgId, finance.userId, "finance");
  await seedWorkers(owner.orgId);
  // Slice 5.9a: this spec tests the off-cycle and bank-file flows on NTA 2025 v1's figures (a
  // dated rule set the company may hold); v2's tax engine is tested in payroll-run.spec.ts and the
  // RLS and unit suites.
  await giveRuleSetV1(adminClient(), owner.orgId);

  // New off-cycle run: final pay, October 2026, paid 16 Oct, Musa Ibrahim only.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signInViaUi(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });
  await page.goto("/app/payroll");
  await page.getByTestId("new-off-cycle").locator("summary").click();
  const form = page.getByRole("form", { name: "New off-cycle run" });
  await form.getByLabel("Why off-cycle").selectOption("final_pay");
  await form.getByLabel("Pay period").selectOption("2026-09-20");
  await form.getByLabel("Pay date").fill("2026-10-16");
  await form.getByLabel("Filter workers by name or staff ID").fill("musa");
  await expect(form.getByRole("checkbox", { name: /Grace Edet/ })).toBeHidden();
  await form.getByRole("checkbox", { name: /Musa Ibrahim/ }).check();
  await form.getByLabel("Reason").fill("Resigned, last day 5 October");
  await form.getByRole("button", { name: "Preview the off-cycle run" }).click();
  const preview = form.getByTestId("run-preview");
  await expect(preview).toContainText("final pay for a leaver", { timeout: 30_000 });
  await expect(preview).toContainText("net pay ₦57,828.57 for 1 of 1 worker");
  await form.getByRole("button", { name: "Prepare the off-cycle run" }).click();
  await expect(page).toHaveURL(/\/app\/payroll\/[0-9a-f-]+\?step=earnings/, { timeout: 30_000 });
  const runPath = new URL(page.url()).pathname;
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "October 2026 off-cycle: Final pay for a leaver",
  );
  await expect(page.getByTestId("off-cycle-label").first()).toBeVisible();
  await expect(page.getByTestId("off-cycle-earnings-hint")).toContainText(
    "Leave encashment and terminal benefits have no rule in the app yet",
  );

  // A manual one-off earning with a reason: leave encashment, ₦10,000.
  const add = page.getByRole("form", { name: "Add an earning or deduction" });
  // The off-cycle run's one worker (after the "Choose a worker" placeholder).
  await expect(add.getByLabel("Worker")).toContainText("Musa Ibrahim");
  await add.getByLabel("Worker").selectOption({ index: 1 });
  await add.getByLabel("Item").fill("Leave encashment");
  await add.getByLabel("Amount (₦)").fill("10000");
  await expect(add.getByLabel("Instalments")).toHaveCount(0);
  await add.getByLabel("Reason").fill("Six annual leave days not taken");
  await add.getByRole("button", { name: "Preview" }).click();
  await expect(add.getByTestId("run-preview")).toBeVisible({ timeout: 30_000 });
  await add.getByRole("button", { name: "Add and recalculate" }).click();
  await expect(add.getByRole("status")).toContainText("Added and recalculated", {
    timeout: 30_000,
  });

  // The period step names the run's reason and worker.
  await goToStep(page, /Period$/, "period");
  await expect(page.getByTestId("off-cycle-panel")).toContainText("Resigned, last day 5 October");
  await expect(page.getByTestId("off-cycle-panel")).toContainText("1 worker: Musa Ibrahim");

  // Acknowledge the warnings (final pay, no bank details, no pension details) and submit.
  await goToStep(page, /Anomalies$/, "anomalies");
  const ack = page.getByRole("form", { name: "Acknowledge anomalies" });
  await expect(ack.getByRole("checkbox").first()).toBeVisible();
  const boxes = ack.getByRole("checkbox");
  const count = await boxes.count();
  for (let i = 0; i < count; i += 1) {
    const box = boxes.nth(i);
    if (await box.isEnabled()) await box.check();
  }
  await ack.getByRole("button", { name: "Acknowledge ticked" }).click();
  await expect(ack.getByRole("status")).toContainText("acknowledged");

  await goToStep(page, /Submit$/, "submit");
  const submit = page.getByRole("form", { name: "Submit to Finance" });
  await submit.getByRole("button", { name: "Submit to Finance" }).click();
  await expect(submit.getByTestId("run-preview")).toContainText("net pay ₦67,828.57 to 1 workers", {
    timeout: 30_000,
  });
  await submit.getByRole("button", { name: "Confirm and submit" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Waiting for Finance approval" }),
  ).toBeVisible({ timeout: 15_000 });

  // The preparer is refused with the two-person message.
  await page.reload();
  const ownApproval = page.getByRole("form", { name: "Approve the run" });
  await ownApproval.getByRole("button", { name: "Check and approve" }).click();
  await expect(ownApproval.getByRole("alert")).toContainText(
    "You prepared or changed this run, so a different person must approve it.",
    { timeout: 30_000 },
  );

  // Finance approves after seeing the totals.
  const financePage = await browser.newPage();
  await financePage.setViewportSize({ width: 1440, height: 1000 });
  await signInViaUi(financePage, finance.email, finance.password);
  await expect(financePage).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });
  await financePage.goto(`${runPath}?step=submit`);
  await expect(financePage.getByTestId("control-totals")).toContainText("Net pay to 1 worker");
  await expect(financePage.getByTestId("control-totals")).toContainText("₦67,829");
  const approval = financePage.getByRole("form", { name: "Approve the run" });
  await approval.getByRole("button", { name: "Check and approve" }).click();
  const approvePreview = approval.getByTestId("run-preview");
  await expect(approvePreview).toContainText(
    "Approves October 2026 off-cycle: Final pay for a leaver, 20 Sep to 19 Oct 2026: net pay ₦67,828.57 to 1 worker",
    { timeout: 30_000 },
  );
  await expect(approvePreview).toContainText("the period stays open for the regular run");
  await approval.getByRole("button", { name: "Confirm and approve" }).click();
  await expect(financePage.getByTestId("posted-note")).toContainText("Approved", {
    timeout: 30_000,
  });
  await financePage.reload();
  await expect(financePage.getByTestId("posted-note")).toContainText(
    "the period stays open for the regular run",
  );

  // 390px: the run and the list fit, and the list labels the run off-cycle.
  await financePage.setViewportSize({ width: 390, height: 900 });
  for (const step of ["period", "earnings", "submit"]) {
    await financePage.goto(`${runPath}?step=${step}`);
    await expect(financePage.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(financePage);
  }
  await financePage.goto("/app/payroll");
  const table = financePage.getByRole("table", { name: "Payroll runs" });
  await expect(table).toContainText("Off-cycle");
  await expect(table).toContainText("Final pay for a leaver");
  await expect(table).toContainText("Approved");
  await expectNoHorizontalScroll(financePage);
  await financePage.close();

  // The owner's list at 390px, with the new off-cycle form open.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/app/payroll");
  await page.getByTestId("new-off-cycle").locator("summary").click();
  await expect(page.getByRole("form", { name: "New off-cycle run" })).toBeVisible();
  await expectNoHorizontalScroll(page);
});
