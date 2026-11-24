/**
 * Slice 5.7a accept line, in the browser: an approved October 2026 run (seeded through the
 * database functions: the owner prepares and submits it, Finance approves it) is reversed before
 * release. Finance asks for the reversal with a reason and sees the negative totals first; the
 * reversal waits for a second person; Finance can't approve their own request; the owner approves
 * it, and the run shows as Reversed with a link to its reversal, and its period is offered again
 * under "Prepare a run". At 1440px, then 390px with no horizontal scroll.
 * (The copies, voids, freed sources and guards are in tests/rls/payroll-reversal.test.ts.)
 */
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import type { Json } from "../../src/types/db";
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

const SHA = "a".repeat(64);

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function signedIn(email: string, password: string) {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return client;
}

/**
 * Musa Ibrahim's October as the engine works it out (golden: gross ₦120,000, PAYE ₦5,660,
 * pension ₦9,600, net ₦104,740), saved with the secret key as the server does.
 */
function results(workerId: string, payRateId: string): Record<string, unknown> {
  const source = [{ kind: "pay_rate", id: payRateId, from: "2026-09-20", to: "2026-10-19" }];
  const line = (
    code: string,
    kind: string,
    label: string,
    amount: string,
    pensionable = false,
  ) => ({
    code,
    kind,
    label,
    amount_kobo: amount,
    pensionable,
    taxable: kind === "earning",
    sources: kind === "earning" ? source : [],
  });
  return {
    itf_applies: false,
    totals: {
      gross_kobo: "12000000",
      paye_kobo: "566000",
      pension_employee_kobo: "960000",
      pension_employer_kobo: "1200000",
      nhf_kobo: "0",
      other_deductions_kobo: "0",
      net_kobo: "10474000",
      nsitf_kobo: "120000",
      itf_kobo: "0",
      employer_cost_kobo: "13320000",
      carried_forward_kobo: "0",
      worker_count: 1,
    },
    payslips: [
      {
        worker_id: workerId,
        employment_type: "permanent",
        tax_state: "Lagos",
        pfa_name: "Stanbic IBTC Pension",
        pay_rate_ids: [payRateId],
        days: { cycle: 30, rostered: 21, employed_rostered: 21, leave_deducted: 0 },
        gross_kobo: "12000000",
        paye_kobo: "566000",
        pension_employee_kobo: "960000",
        nhf_kobo: "0",
        other_deductions_kobo: "0",
        net_kobo: "10474000",
        carried_forward_kobo: "0",
        pension_employer_kobo: "1200000",
        nsitf_kobo: "120000",
        itf_kobo: "0",
        employer_cost_kobo: "13320000",
        trace: { trace_version: 1, steps: [] },
        lines: [
          line("basic", "earning", "Basic, 20 Sep to 19 Oct", "6000000", true),
          line("housing", "earning", "Housing, 20 Sep to 19 Oct", "3600000", true),
          line("transport", "earning", "Transport, 20 Sep to 19 Oct", "2400000", true),
          line("paye", "statutory", "PAYE", "566000"),
          line("pension_employee", "statutory", "Employee pension 8%", "960000"),
          line("pension_employer", "employer", "Employer pension 10%", "1200000"),
          line("nsitf", "employer", "NSITF 1%", "120000"),
        ],
      },
    ],
    anomalies: [],
  };
}

test("Finance reverses an approved run before release; a second person approves; the period reopens", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const admin = adminClient();
  const owner = await createOwner("prev-owner", `Marina Guards ${uniqueSuffix()}`);
  const finance = await createAccount("prev-fin", "Adaeze Okafor");
  await addMembership(owner.orgId, finance.userId, "finance");

  // An approved October run: the owner prepares and submits, Finance approves.
  const workerId = randomUUID();
  const w = await admin.from("workers").insert({
    id: workerId,
    organisation_id: owner.orgId,
    staff_id: `REV-${randomUUID().slice(0, 6)}`,
    first_name: "Musa",
    last_name: "Ibrahim",
    employment_type: "permanent",
    start_date: "2025-01-06",
    tax_state: "Lagos",
    pfa_name: "Stanbic IBTC Pension",
  });
  if (w.error) throw new Error(w.error.message);
  const rate = await admin
    .from("pay_rates")
    .insert({
      organisation_id: owner.orgId,
      worker_id: workerId,
      pay_type: "monthly",
      basic_kobo: 6_000_000,
      housing_kobo: 3_600_000,
      transport_kobo: 2_400_000,
      other_allowances_kobo: 0,
      effective_from: "2025-01-06",
    })
    .select("id")
    .single();
  if (rate.error) throw new Error(rate.error.message);
  const ownerClient = await signedIn(owner.email, owner.password);
  const financeClient = await signedIn(finance.email, finance.password);
  const created = await ownerClient.rpc("create_payroll_run", {
    p_organisation_id: owner.orgId,
    p_period_start: "2026-09-20",
  });
  if (created.error) throw new Error(created.error.message);
  const runId = created.data!;
  const saved = await admin.rpc("save_payroll_results", {
    p_organisation_id: owner.orgId,
    p_run_id: runId,
    p_actor: owner.userId,
    p_results: results(workerId, rate.data.id) as unknown as Json,
    p_inputs_sha256: SHA,
  });
  if (saved.error) throw new Error(saved.error.message);
  const submitted = await ownerClient.rpc("submit_payroll_run", {
    p_organisation_id: owner.orgId,
    p_run_id: runId,
  });
  if (submitted.error) throw new Error(submitted.error.message);
  const clock = await admin.rpc("payroll_clock");
  const check = await admin.rpc("record_payroll_approval_check", {
    p_organisation_id: owner.orgId,
    p_run_id: runId,
    p_actor: finance.userId,
    p_inputs_sha256: SHA,
    p_read_started_at: clock.data!,
  });
  if (check.error) throw new Error(check.error.message);
  const approved = await financeClient.rpc("approve_payroll_run", {
    p_organisation_id: owner.orgId,
    p_run_id: runId,
  });
  if (approved.error) throw new Error(approved.error.message);

  // Finance asks for the reversal: the negative totals first, then the request.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signInViaUi(page, finance.email, finance.password);
  await expect(page).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });
  await page.goto(`/app/payroll/${runId}?step=submit`);
  const panel = page.getByTestId("reverse-panel");
  await expect(panel).toBeVisible();
  const ask = page.getByRole("form", { name: "Reverse this run" });
  await ask.getByLabel("Reason").fill("Overtime at Apapa was approved twice");
  await ask.getByRole("button", { name: "Preview the reversal" }).click();
  const preview = ask.getByTestId("run-preview");
  await expect(preview).toContainText("net pay -₦104,740", { timeout: 30_000 });
  await expect(preview).toContainText("waits for a second person");
  await ask.getByRole("button", { name: "Ask for the reversal" }).click();
  await expect(page).toHaveURL(/\/app\/payroll\/[0-9a-f-]+\?step=submit/, { timeout: 30_000 });
  const reversalPath = new URL(page.url()).pathname;
  expect(reversalPath).not.toBe(`/app/payroll/${runId}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Reversal of October 2026");
  await expect(page.getByTestId("reversal-totals")).toContainText("-₦104,740");
  await expect(page.getByTestId("reversal-banner")).toContainText("This reverses");

  // The requester can't approve it.
  const own = page.getByRole("form", { name: "Approve the reversal" });
  await own.getByRole("button", { name: "Check and approve" }).click();
  await expect(own.getByRole("alert")).toContainText(
    "You asked for this reversal, so a different person must approve it.",
    { timeout: 30_000 },
  );

  // The owner approves it in a separate session.
  const ownerPage = await browser.newPage();
  await ownerPage.setViewportSize({ width: 1440, height: 1000 });
  await signInViaUi(ownerPage, owner.email, owner.password);
  await expect(ownerPage).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });
  await ownerPage.goto(`/app/payroll/${runId}`);
  await expect(ownerPage.getByTestId("reversal-waiting")).toContainText(
    "Reversal waiting for approval",
  );
  await ownerPage.goto(`${reversalPath}?step=submit`);
  const approval = ownerPage.getByRole("form", { name: "Approve the reversal" });
  await approval.getByRole("button", { name: "Check and approve" }).click();
  await expect(approval.getByTestId("run-preview")).toContainText(
    "Approves the reversal of October 2026",
    { timeout: 30_000 },
  );
  await approval.getByRole("button", { name: "Confirm and reverse the run" }).click();
  await expect(ownerPage.getByTestId("reversal-approved")).toContainText("Reversal approved", {
    timeout: 30_000,
  });
  await ownerPage.reload();
  await expect(ownerPage.getByTestId("reversal-approved")).toContainText("by Test Owner");

  // The run shows Reversed with a link to its reversal; its period is offered again.
  await ownerPage.goto(`/app/payroll/${runId}`);
  const banner = ownerPage.getByTestId("reversed-banner");
  await expect(banner).toContainText("Reversed");
  await expect(banner.getByRole("link", { name: "See the reversal" })).toHaveAttribute(
    "href",
    `${reversalPath}?step=submit`,
  );
  await expect(ownerPage.getByTestId("reverse-panel")).toHaveCount(0);
  await ownerPage.goto("/app/payroll");
  await expect(ownerPage.getByRole("table", { name: "Payroll runs" })).toContainText(
    "Reversal of October 2026",
  );
  const create = ownerPage.getByRole("form", { name: "Prepare a payroll run" });
  await expect(create.getByLabel("Pay period").locator('option[value="2026-09-20"]')).toHaveCount(
    1,
  );

  // 390px: the reversed run, the reversal and the list fit with no horizontal scroll.
  await ownerPage.setViewportSize({ width: 390, height: 900 });
  for (const path of [`/app/payroll/${runId}?step=period`, `${reversalPath}?step=submit`]) {
    await ownerPage.goto(path);
    await expect(ownerPage.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(ownerPage);
  }
  await ownerPage.goto("/app/payroll");
  await expectNoHorizontalScroll(ownerPage);
  await ownerPage.close();
});
