/**
 * Slice 5.2 accept line: HR creates the October 2026 run (20 Sep to 19 Oct, paid 25 Oct) for the
 * six golden workers; Gross to net shows ₦870,000 / ₦55,150 / ₦69,600 / ₦745,250 / ₦974,400;
 * Explain shows Musa Ibrahim's PAYE of ₦5,660; submit is refused while an anomaly is
 * unacknowledged; HR adds an allowance, acknowledges the anomalies and submits. At 1440px, then
 * 390px with no horizontal scroll.
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
async function seedGoldenWorkers(orgId: string): Promise<Record<string, string>> {
  const admin = adminClient();
  const ids: Record<string, string> = {};
  for (const w of golden.workers) {
    const [first, last] = w.name.split(" ");
    const { data, error } = await admin
      .from("workers")
      .insert({
        organisation_id: orgId,
        staff_id: `GW-${randomUUID().slice(0, 6)}`,
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
    ids[w.name] = data.id;
  }
  return ids;
}

test("HR prepares the October run, sees the golden figures and Explain, and submits after acknowledging", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const owner = await createOwner("prun-owner", `Coastline Security ${uniqueSuffix()}`);
  const hr = await createAccount("prun-hr", "Oluwaseun Adeyemi");
  await addMembership(owner.orgId, hr.userId, "hr");
  const workers = await seedGoldenWorkers(owner.orgId);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await signInViaUi(page, hr.email, hr.password);
  await expect(page).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });

  await page.goto("/app/payroll");
  await expect(page.getByRole("heading", { level: 1, name: "Payroll run" })).toBeVisible();
  const create = page.getByRole("form", { name: "Prepare a payroll run" });
  await create.getByLabel("Pay period").selectOption("2026-09-20");
  await create.getByRole("button", { name: "Preview the run" }).click();
  await expect(create.getByTestId("run-preview")).toContainText(
    "Prepares 20 Sep to 19 Oct 2026 for 6 workers, paid 25 Oct 2026",
    { timeout: 30_000 },
  );
  await create.getByRole("button", { name: "Prepare the run" }).click();
  await expect(page).toHaveURL(/\/app\/payroll\/[0-9a-f-]+\?step=gross-to-net/, {
    timeout: 30_000,
  });
  await expect(
    page.getByRole("heading", { level: 1, name: "Run October 2026 payroll" }),
  ).toBeVisible();

  // The accept line's totals: gross, PAYE, employee pension, net, employer cost.
  const totals = page.getByTestId("gross-to-net-totals");
  await expect(totals).toContainText("These 6 workers");
  for (const figure of ["₦870,000", "₦55,150", "₦69,600", "₦745,250", "₦974,400"]) {
    await expect(totals).toContainText(figure);
  }
  await expect(page.getByTestId("gross-to-net-row")).toHaveCount(6);

  // Explain: how Musa Ibrahim's PAYE is worked out.
  await page.getByRole("link", { name: "Explain Musa Ibrahim" }).click();
  await expect(page).toHaveURL(/explain=/);
  const explain = page.getByTestId("explain");
  await expect(explain).toContainText("How Musa Ibrahim's PAYE is worked out");
  await expect(explain).toContainText("Gross pay (₦120,000 × 12)");
  await expect(explain).toContainText("15% on ₦452,800");
  await expect(explain.getByRole("definition").last()).toHaveText("₦5,660");

  // Submit is refused while anomalies wait for acknowledgement.
  await page
    .getByRole("link", { name: /Submit$/ })
    .first()
    .click();
  await expect(page).toHaveURL(/step=submit/);
  const submit = page.getByRole("form", { name: "Submit to Finance" });
  await submit.getByRole("button", { name: "Submit to Finance" }).click();
  await expect(submit.getByTestId("run-preview")).toContainText("Submits 20 Sep to 19 Oct 2026");
  await submit.getByRole("button", { name: "Confirm and submit" }).click();
  await expect(submit.getByRole("alert")).toContainText(/Acknowledge \d+ more anomal/);

  // An allowance for Grace Edet, previewed, then added and recalculated.
  await page
    .getByRole("link", { name: /Earnings$/ })
    .first()
    .click();
  await expect(page).toHaveURL(/step=earnings/);
  const add = page.getByRole("form", { name: "Add an earning or deduction" });
  await add.getByLabel("Worker").selectOption(workers["Grace Edet"]!);
  await add.getByLabel("Item").fill("Supervisor allowance");
  await add.getByLabel("Amount (₦)").fill("15,000");
  await add.getByLabel("Reason").fill("Acting supervisor at VI Tower, October");
  await add.getByRole("button", { name: "Preview" }).click();
  await expect(add.getByTestId("run-preview")).toContainText("Adds an earning of ₦15,000");
  await add.getByRole("button", { name: "Add and recalculate" }).click();
  await expect(add.getByRole("status")).toHaveText("Added and recalculated", { timeout: 30_000 });
  await expect(page.getByRole("table", { name: "Earnings and changes" })).toContainText(
    "Supervisor allowance",
  );

  // Acknowledge every anomaly.
  await page
    .getByRole("link", { name: /Anomalies$/ })
    .first()
    .click();
  await expect(page).toHaveURL(/step=anomalies/);
  await expect(
    page.getByRole("form", { name: "Acknowledge anomalies" }).getByRole("checkbox").first(),
  ).toBeVisible();
  const ack = page.getByRole("form", { name: "Acknowledge anomalies" });
  const boxes = ack.getByRole("checkbox");
  const count = await boxes.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    const box = boxes.nth(i);
    if (await box.isEnabled()) await box.check();
  }
  await ack.getByRole("button", { name: "Acknowledge ticked" }).click();
  await expect(ack.getByRole("status")).toContainText("acknowledged");

  // Musa's PAYE is unchanged by Grace's allowance.
  await page
    .getByRole("link", { name: /Gross to net$/ })
    .first()
    .click();
  await expect(page).toHaveURL(/step=gross-to-net/);
  await page.getByRole("link", { name: "Explain Musa Ibrahim" }).click();
  await expect(page).toHaveURL(/explain=/);
  await expect(page.getByTestId("explain").getByRole("definition").last()).toHaveText("₦5,660");

  await page
    .getByRole("link", { name: /Submit$/ })
    .first()
    .click();
  await expect(page).toHaveURL(/step=submit/);
  const submitAgain = page.getByRole("form", { name: "Submit to Finance" });
  await expect(page.getByTestId("control-totals")).toContainText("Net pay to 6 workers");
  await submitAgain.getByRole("button", { name: "Submit to Finance" }).click();
  await submitAgain.getByRole("button", { name: "Confirm and submit" }).click();
  // Submitted: the run is in review, so the submit form gives way to the waiting status.
  await expect(
    page.getByRole("status").filter({ hasText: "Waiting for Finance approval" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("form", { name: "Submit to Finance" })).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("status").filter({ hasText: "Waiting for Finance approval" }),
  ).toBeVisible();

  // 390px: the run and its steps fit with no horizontal scroll.
  await page.setViewportSize({ width: 390, height: 900 });
  for (const step of ["period", "gross-to-net", "anomalies", "submit"]) {
    await page.goto(`${new URL(page.url()).pathname}?step=${step}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page);
  }
  await page.goto("/app/payroll");
  await expect(page.getByRole("table", { name: "Payroll runs" })).toContainText(
    "Waiting for approval",
  );
  await expectNoHorizontalScroll(page);
});
