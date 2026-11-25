/**
 * Slice 5.6 accept line, in the browser: the October 2026 run is approved by a second person in
 * Finance (seeded through the database functions, as the RLS suite does), so it owes PAYE to
 * Lagos State IRS, pension to the worker's PFA and NSITF. HR opens Statutory remittances,
 * downloads the pension schedule through its 60-second link, and records the pension payment with
 * a receipt (checked, then recorded); the remittance shows as paid with its receipt. At 1440px,
 * then 390px with no horizontal scroll.
 * (Grouping, due dates, insert-only, the buckets and the golden statutory totals are checked in
 * tests/unit/payroll/statutory.test.ts, tests/rls/statutory-remittances.test.ts and
 * tests/rls/payroll-golden.test.ts.)
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import type { Json } from "@/types/db";

import { adminClient, anonClient, type Client } from "../rls/helpers/supabase";
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

const OCT_START = "2026-09-20";
const OCT_END = "2026-10-19";
const SHA = "a".repeat(64);
const PDF = Buffer.from("%PDF-1.4\n% receipt\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function signedIn(email: string, password: string): Promise<Client> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return client;
}

const line = (
  code: string,
  kind: string,
  label: string,
  amount: number,
  sources: unknown[] = [],
) => ({
  code,
  kind,
  label,
  amount_kobo: String(amount),
  pensionable: kind === "earning",
  taxable: kind === "earning",
  sources,
});

/**
 * One worker on ₦120,000 in Lagos with a PFA: PAYE ₦1,000, pension ₦9,600 + ₦12,000, NSITF
 * ₦1,200. Prepared and submitted by the owner, approved by Finance.
 */
async function seedApprovedRun(orgId: string, owner: Client, finance: Client, financeId: string) {
  const admin = adminClient();
  const { data: worker, error } = await admin
    .from("workers")
    .insert({
      organisation_id: orgId,
      staff_id: `RM-${randomUUID().slice(0, 6)}`,
      first_name: "Musa",
      last_name: "Ibrahim",
      employment_type: "permanent",
      start_date: "2025-01-06",
      tax_state: "Lagos",
      pfa_name: "Stanbic IBTC Pensions",
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const { data: rate, error: rateError } = await admin
    .from("pay_rates")
    .insert({
      organisation_id: orgId,
      worker_id: worker.id,
      pay_type: "monthly",
      basic_kobo: 6_000_000,
      housing_kobo: 3_600_000,
      transport_kobo: 2_400_000,
      other_allowances_kobo: 0,
      effective_from: "2025-01-06",
    })
    .select("id")
    .single();
  if (rateError) throw new Error(rateError.message);
  const created = await owner.rpc("create_payroll_run", {
    p_organisation_id: orgId,
    p_period_start: OCT_START,
  });
  if (created.error) throw new Error(created.error.message);
  const runId = created.data!;
  const source = [{ kind: "pay_rate", id: rate.id, from: OCT_START, to: OCT_END }];
  const totals = {
    gross_kobo: "12000000",
    paye_kobo: "100000",
    pension_employee_kobo: "960000",
    pension_employer_kobo: "1200000",
    nhf_kobo: "0",
    other_deductions_kobo: "0",
    net_kobo: "10940000",
    nsitf_kobo: "120000",
    itf_kobo: "0",
    employer_cost_kobo: "13320000",
    carried_forward_kobo: "0",
  };
  const doc = {
    itf_applies: false,
    totals: { ...totals, worker_count: 1 },
    payslips: [
      {
        worker_id: worker.id,
        employment_type: "permanent",
        tax_state: "Lagos",
        pfa_name: "Stanbic IBTC Pensions",
        pay_rate_ids: [rate.id],
        days: { cycle: 30, rostered: 21, employed_rostered: 21, leave_deducted: 0 },
        ...totals,
        trace: { trace_version: 1, steps: [] },
        lines: [
          line("basic", "earning", "Basic, 20 Sep to 19 Oct", 6_000_000, source),
          line("housing", "earning", "Housing, 20 Sep to 19 Oct", 3_600_000, source),
          line("transport", "earning", "Transport, 20 Sep to 19 Oct", 2_400_000, source),
          line("paye", "statutory", "PAYE", 100_000),
          line("pension_employee", "statutory", "Employee pension 8%", 960_000),
          line("pension_employer", "employer", "Employer pension 10%", 1_200_000),
          line("nsitf", "employer", "NSITF 1%", 120_000),
        ],
      },
    ],
    anomalies: [],
  };
  const { data: ownerUser } = await owner.auth.getUser();
  const saved = await admin.rpc("save_payroll_results", {
    p_organisation_id: orgId,
    p_run_id: runId,
    p_actor: ownerUser.user!.id,
    p_results: doc as unknown as Json,
    p_inputs_sha256: SHA,
  });
  if (saved.error) throw new Error(saved.error.message);
  const submitted = await owner.rpc("submit_payroll_run", {
    p_organisation_id: orgId,
    p_run_id: runId,
  });
  if (submitted.error) throw new Error(submitted.error.message);
  const clock = await admin.rpc("payroll_clock");
  const checked = await admin.rpc("record_payroll_approval_check", {
    p_organisation_id: orgId,
    p_run_id: runId,
    p_actor: financeId,
    p_inputs_sha256: SHA,
    p_read_started_at: clock.data!,
  });
  if (checked.error) throw new Error(checked.error.message);
  const approved = await finance.rpc("approve_payroll_run", {
    p_organisation_id: orgId,
    p_run_id: runId,
  });
  if (approved.error) throw new Error(approved.error.message);
  return runId;
}

test("HR downloads the pension schedule and records the payment with its receipt", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const owner = await createOwner("prem-owner", `Coastline Security ${uniqueSuffix()}`);
  const hr = await createAccount("prem-hr", "Oluwaseun Adeyemi");
  const finance = await createAccount("prem-fin", "Adaeze Okafor");
  await addMembership(owner.orgId, hr.userId, "hr");
  await addMembership(owner.orgId, finance.userId, "finance");
  const runId = await seedApprovedRun(
    owner.orgId,
    await signedIn(owner.email, owner.password),
    await signedIn(finance.email, finance.password),
    finance.userId,
  );

  await page.setViewportSize({ width: 1440, height: 1000 });
  await signInViaUi(page, hr.email, hr.password);
  await expect(page).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });
  await page.goto("/app/payroll");
  await page.getByRole("link", { name: "Statutory remittances" }).click();
  await expect(page).toHaveURL(/\/app\/payroll\/remittances$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Statutory remittances" }),
  ).toBeVisible();
  await expect(page.getByTestId("adviser-line")).toContainText("Confirm with a tax adviser");

  const cards = page.getByTestId("remittance");
  await expect(cards).toHaveCount(3);
  const paye = page.getByRole("listitem", { name: "PAYE to Lagos State IRS" });
  await expect(paye.getByTestId("remittance-amount")).toHaveText("₦1,000.00");
  // Slice 5.9b: PAYE is due the 10th of the following month, with the penalty date shown.
  await expect(paye).toContainText("Due 10 Nov 2026");
  await expect(paye.getByTestId("deadline-notes")).toContainText(
    "Statutory penalty after 21 Nov 2026",
  );
  const pension = page.getByRole("listitem", { name: "Pension to Stanbic IBTC Pensions" });
  await expect(pension.getByTestId("remittance-amount")).toHaveText("₦21,600.00");
  // Slice 5.9b: paid Sunday 25 Oct 2026, so Monday 26 Oct is day 1 of 7; provisional until the
  // bank file is uploaded.
  await expect(pension).toContainText("Due 3 Nov 2026");
  await expect(pension.getByTestId("deadline-notes")).toContainText("Provisional");
  await expect(page.getByTestId("h1-note")).toContainText("Form H1");
  await expect(
    page.getByRole("listitem", { name: "NSITF" }).getByTestId("remittance-amount"),
  ).toHaveText("₦1,200.00");

  // The schedule downloads through its 60-second link.
  const downloading = page.waitForEvent("download");
  await pension.getByRole("link", { name: /Download schedule/ }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("pension-to-stanbic-ibtc-pensions-2026-10.csv");
  const csv = await readFile((await download.path())!, "utf8");
  expect(csv).toContain("Staff ID,Name,RSA PIN,Employee (NGN),Employer (NGN),Total (NGN)");
  expect(csv).toContain(",Musa Ibrahim,Not on file,9600.00,12000.00,21600.00");
  expect(csv).toContain("Total,1 worker,,9600.00,12000.00,21600.00");

  // Record the payment: check it, then upload the receipt and record.
  await pension.locator("summary", { hasText: "Record payment" }).click();
  const form = pension.getByRole("form", { name: "Record payment" });
  await form.getByLabel("Bank reference (optional)").fill("PFA-1029");
  await form.getByLabel("Receipt", { exact: true }).setInputFiles({
    name: "pension-receipt.pdf",
    mimeType: "application/pdf",
    buffer: PDF,
  });
  await form.getByRole("button", { name: "Check the payment" }).click();
  await expect(form.getByTestId("remittance-preview")).toContainText("Records ₦21,600 paid on", {
    timeout: 15_000,
  });
  await expect(form.getByTestId("remittance-preview")).toContainText("the amount due");
  await form.getByRole("button", { name: "Upload receipt and record" }).click();
  await expect(pension.getByTestId("remittance-paid")).toBeVisible({ timeout: 30_000 });
  await page.reload();
  const paid = page.getByRole("listitem", { name: "Pension to Stanbic IBTC Pensions" });
  await expect(paid.getByTestId("remittance-paid")).toContainText("Paid ₦21,600.00 on");
  await expect(paid.getByTestId("remittance-paid")).toContainText("ref PFA-1029");
  await expect(paid.getByTestId("remittance-paid")).toContainText("Recorded by Oluwaseun Adeyemi");
  await expect(paid.getByRole("button", { name: "View receipt" })).toBeVisible();
  await expect(paid.getByRole("form", { name: "Record payment" })).toHaveCount(0);

  // The run links here once posted.
  await page.goto(`/app/payroll/${runId}?step=submit`);
  await expect(
    page.getByTestId("posted-note").getByRole("link", { name: "Statutory remittances" }),
  ).toBeVisible();

  // 390px: no horizontal scroll.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/app/payroll/remittances");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.goto(`/app/payroll/remittances?run=${runId}`);
  await expect(page.getByTestId("remittance")).toHaveCount(3);
  await expectNoHorizontalScroll(page);
});
