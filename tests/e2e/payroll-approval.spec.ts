/**
 * Slice 5.3 accept line, in the browser: the owner prepares and submits the October 2026 run for
 * the six golden workers; their own approval is refused with the two-person message; a second
 * person in Finance sees the control totals and every acknowledged anomaly, approves, and the
 * run shows as approved and posted. At 1440px, then 390px with no horizontal scroll.
 * (The stored payslips against the golden fixture, the period lock and hr's refusal are checked in
 * tests/rls/payroll-golden.test.ts and payroll-approval.test.ts.)
 */
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import golden from "../../fixtures/october-2026-golden.json";
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

/** The six golden workers: full cycle, 50% basic / 30% housing / 20% transport, Lagos. */
async function seedGoldenWorkers(orgId: string): Promise<void> {
  const admin = adminClient();
  for (const w of golden.workers) {
    const [first, last] = w.name.split(" ");
    const { data, error } = await admin
      .from("workers")
      .insert({
        organisation_id: orgId,
        staff_id: `GA-${randomUUID().slice(0, 6)}`,
        first_name: first!,
        last_name: last!,
        employment_type: "permanent",
        start_date: "2025-01-06",
        tax_state: "Lagos",
        annual_rent_declared_kobo: w.annual_rent * 100,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const gross = w.gross * 100;
    const basic = gross / 2;
    const housing = (gross * 3) / 10;
    const rate = await admin.from("pay_rates").insert({
      organisation_id: orgId,
      worker_id: data.id,
      pay_type: "monthly",
      basic_kobo: basic,
      housing_kobo: housing,
      transport_kobo: gross - basic - housing,
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

test("the preparer can't approve their own run; Finance approves it after seeing the totals and anomalies", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const owner = await createOwner("pappr-owner", `Coastline Security ${uniqueSuffix()}`);
  const finance = await createAccount("pappr-fin", "Adaeze Okafor");
  await addMembership(owner.orgId, finance.userId, "finance");
  await seedGoldenWorkers(owner.orgId);

  // The owner prepares the run, acknowledges every anomaly and submits it.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signInViaUi(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });
  await page.goto("/app/payroll");
  const create = page.getByRole("form", { name: "Prepare a payroll run" });
  await create.getByLabel("Pay period").selectOption("2026-09-20");
  await create.getByRole("button", { name: "Preview the run" }).click();
  await expect(create.getByTestId("run-preview")).toContainText("for 6 workers", {
    timeout: 30_000,
  });
  await create.getByRole("button", { name: "Prepare the run" }).click();
  await expect(page).toHaveURL(/\/app\/payroll\/[0-9a-f-]+\?step=gross-to-net/, {
    timeout: 30_000,
  });
  const runPath = new URL(page.url()).pathname;

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
  await submit.getByRole("button", { name: "Confirm and submit" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Waiting for Finance approval" }),
  ).toBeVisible({ timeout: 15_000 });

  // The owner can decide payroll, but prepared this run: refused with the two-person message.
  await page.reload();
  const ownApproval = page.getByRole("form", { name: "Approve the run" });
  await ownApproval.getByRole("button", { name: "Check and approve" }).click();
  await expect(ownApproval.getByRole("alert")).toContainText(
    "You prepared or changed this run, so a different person must approve it.",
    { timeout: 30_000 },
  );

  // Finance, in a separate session: the totals and the acknowledged anomalies, then approve.
  const financePage = await browser.newPage();
  await financePage.setViewportSize({ width: 1440, height: 1000 });
  await signInViaUi(financePage, finance.email, finance.password);
  await expect(financePage).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });
  await financePage.goto(`${runPath}?step=submit`);
  await expect(financePage.getByRole("heading", { level: 2, name: "Approval" })).toBeVisible();
  await expect(financePage.getByTestId("control-totals")).toContainText("Net pay to 6 workers");
  await expect(financePage.getByTestId("control-totals")).toContainText("₦745,250");
  const panel = financePage.getByTestId("approval-panel");
  await expect(panel.getByRole("list", { name: "Acknowledged anomalies" })).toBeVisible();
  await expect(panel.getByRole("listitem").first()).toContainText("Acknowledged by");

  const approval = financePage.getByRole("form", { name: "Approve the run" });
  await approval.getByRole("button", { name: "Check and approve" }).click();
  const preview = approval.getByTestId("run-preview");
  await expect(preview).toContainText(
    "Approves 20 Sep to 19 Oct 2026: net pay ₦745,250 to 6 workers",
    {
      timeout: 30_000,
    },
  );
  await expect(preview).toContainText("Nothing it was worked out from has changed");
  await expect(preview).toContainText("Anomalies acknowledged");
  await approval.getByRole("button", { name: "Confirm and approve" }).click();
  await expect(financePage.getByTestId("posted-note")).toContainText("Approved", {
    timeout: 30_000,
  });
  await financePage.reload();
  await expect(financePage.getByTestId("posted-note")).toContainText("by Adaeze Okafor");
  await expect(financePage.getByRole("form", { name: "Approve the run" })).toHaveCount(0);

  // 390px: the approved run and the list fit with no horizontal scroll.
  await financePage.setViewportSize({ width: 390, height: 900 });
  for (const step of ["period", "submit"]) {
    await financePage.goto(`${runPath}?step=${step}`);
    await expect(financePage.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(financePage);
  }
  await financePage.goto("/app/payroll");
  await expect(financePage.getByRole("table", { name: "Payroll runs" })).toContainText("Approved");
  await expectNoHorizontalScroll(financePage);
  await financePage.close();
});
