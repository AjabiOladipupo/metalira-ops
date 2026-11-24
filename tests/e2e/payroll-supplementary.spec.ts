/**
 * Slice 5.7c, in the browser: a supplementary bank file for a worker a released run's file left
 * out. October 2026 is seeded through the real functions (the owner prepares and submits, Finance
 * approves after the server's input check; the owner makes the bank file, which pays Musa Ibrahim
 * and leaves Ada Obi out for missing bank details as HR acknowledged; Finance releases). Ada then
 * gets bank details. On the Pay step the owner sees her outstanding and ready, makes the
 * supplementary file (preview, then control totals), downloads it (her number is in the file and
 * nowhere on the page), can't confirm it (they prepared the run); Finance confirms it went to the
 * bank and she is no longer outstanding. At 1440px, then 390px with no horizontal scroll.
 * (The SQL rules are in tests/rls/payout-supplements.test.ts.)
 */
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import type { Database, Json } from "@/types/db";

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
test.skip(
  !process.env.PII_ENCRYPTION_KEY,
  "Needs PII_ENCRYPTION_KEY set for the app under test (any throwaway 32-byte base64 key)",
);

type Client = ReturnType<typeof anonClient>;
type Role = Database["public"]["Enums"]["membership_role"];

const MUSA_NUMBER = "0123456789";
const ADA_NUMBER = "2034567891";
const OCT_START = "2026-09-20";
const OCT_END = "2026-10-19";
// Each worker: gross ₦120,000, PAYE ₦1,000, pension ₦9,600, net ₦109,400.
const NET = 10_940_000;

function encryptAccount(number: string, orgId: string, workerId: string): string {
  const key = Buffer.from(process.env.PII_ENCRYPTION_KEY!, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(
    Buffer.concat([
      Buffer.from([1]),
      Buffer.from(`${orgId}|workers|bank_account_enc|${workerId}`, "utf8"),
    ]),
  );
  const body = Buffer.concat([cipher.update(number, "utf8"), cipher.final()]);
  return `\\x${Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]).toString("hex")}`;
}

async function signedIn(email: string, password: string): Promise<Client> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return client;
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

function ok<R extends { error: { message: string } | null }>(
  r: R,
  what: string,
): R extends { data: infer D } ? NonNullable<D> : never {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return (r as unknown as { data: unknown }).data as R extends { data: infer D }
    ? NonNullable<D>
    : never;
}

/** One worker's payslip as the server would save it (the SQL checks identities and sums). */
function slip(workerId: string, payRateId: string) {
  const src = [{ kind: "pay_rate", id: payRateId, from: OCT_START, to: OCT_END }];
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
  return {
    worker_id: workerId,
    employment_type: "permanent",
    tax_state: "Lagos",
    pfa_name: null,
    pay_rate_ids: [payRateId],
    days: { cycle: 30, rostered: 21, employed_rostered: 21, leave_deducted: 0 },
    gross_kobo: "12000000",
    paye_kobo: "100000",
    pension_employee_kobo: "960000",
    nhf_kobo: "0",
    other_deductions_kobo: "0",
    net_kobo: String(NET),
    carried_forward_kobo: "0",
    pension_employer_kobo: "1200000",
    nsitf_kobo: "120000",
    itf_kobo: "0",
    employer_cost_kobo: "13320000",
    trace: { trace_version: 1, steps: [] },
    lines: [
      line("basic", "earning", "Basic, 20 Sep to 19 Oct", 6_000_000, src),
      line("housing", "earning", "Housing, 20 Sep to 19 Oct", 3_600_000, src),
      line("transport", "earning", "Transport, 20 Sep to 19 Oct", 2_400_000, src),
      line("paye", "statutory", "PAYE", 100_000),
      line("pension_employee", "statutory", "Employee pension 8%", 960_000),
      line("pension_employer", "employer", "Employer pension 10%", 1_200_000),
      line("nsitf", "employer", "NSITF 1%", 120_000),
    ],
  };
}

/** October released with Ada Obi left out of the bank file. Returns the run and Ada's id. */
async function seedReleasedRun(
  orgId: string,
  owner: Client,
  ownerId: string,
  finance: Client,
  financeId: string,
): Promise<{ runId: string; adaId: string }> {
  const admin = adminClient();
  const workers: { id: string; rate: string }[] = [];
  for (const [first, last, number] of [
    ["Musa", "Ibrahim", MUSA_NUMBER],
    ["Ada", "Obi", null],
  ] as const) {
    const id = randomUUID();
    ok(
      await admin.from("workers").insert({
        id,
        organisation_id: orgId,
        staff_id: `SUP-${randomUUID().slice(0, 6)}`,
        first_name: first,
        last_name: last,
        employment_type: "permanent",
        start_date: "2025-01-06",
        tax_state: "Lagos",
        ...(number
          ? {
              bank_name: "GTBank",
              account_name: `${first} ${last}`.toUpperCase(),
              bank_code: "058",
              bank_account_enc: encryptAccount(number, orgId, id),
              bank_account_last4: number.slice(-4),
            }
          : {}),
      }),
      "worker",
    );
    const rate = ok(
      await admin
        .from("pay_rates")
        .insert({
          organisation_id: orgId,
          worker_id: id,
          pay_type: "monthly",
          basic_kobo: 6_000_000,
          housing_kobo: 3_600_000,
          transport_kobo: 2_400_000,
          other_allowances_kobo: 0,
          effective_from: "2025-01-06",
        })
        .select("id")
        .single(),
      "pay rate",
    );
    workers.push({ id, rate: rate.id });
  }
  const runId = ok(
    await owner.rpc("create_payroll_run", { p_organisation_id: orgId, p_period_start: OCT_START }),
    "create run",
  )!;
  const total = (n: number) => String(n * 2);
  ok(
    await admin.rpc("save_payroll_results", {
      p_organisation_id: orgId,
      p_run_id: runId,
      p_actor: ownerId,
      p_inputs_sha256: "a".repeat(64),
      p_results: {
        itf_applies: false,
        totals: {
          gross_kobo: total(12_000_000),
          paye_kobo: total(100_000),
          pension_employee_kobo: total(960_000),
          pension_employer_kobo: total(1_200_000),
          nhf_kobo: "0",
          other_deductions_kobo: "0",
          net_kobo: total(NET),
          nsitf_kobo: total(120_000),
          itf_kobo: "0",
          employer_cost_kobo: total(13_320_000),
          carried_forward_kobo: "0",
          worker_count: 2,
        },
        payslips: workers.map((w) => slip(w.id, w.rate)),
        anomalies: [
          { worker_id: workers[1]!.id, code: "bank_missing", severity: "warning", detail: {} },
        ],
      } as unknown as Json,
    }),
    "save results",
  );
  const anomalies = ok(
    await admin.from("payroll_anomalies").select("id").eq("run_id", runId),
    "anomalies",
  )!;
  ok(
    await owner.rpc("acknowledge_payroll_anomalies", {
      p_organisation_id: orgId,
      p_run_id: runId,
      p_anomaly_ids: anomalies.map((a) => a.id),
    }),
    "acknowledge",
  );
  ok(
    await owner.rpc("submit_payroll_run", { p_organisation_id: orgId, p_run_id: runId }),
    "submit",
  );
  const clock = ok(await admin.rpc("payroll_clock"), "clock")!;
  ok(
    await admin.rpc("record_payroll_approval_check", {
      p_organisation_id: orgId,
      p_run_id: runId,
      p_actor: financeId,
      p_inputs_sha256: "a".repeat(64),
      p_read_started_at: clock,
    }),
    "check",
  );
  ok(
    await finance.rpc("approve_payroll_run", { p_organisation_id: orgId, p_run_id: runId }),
    "approve",
  );

  // The bank file: Musa paid, Ada left out (as the server's two steps would record it).
  const slips = ok(
    await admin.from("payslips").select("id, worker_id").eq("run_id", runId),
    "payslips",
  )!;
  const musaSlip = slips.find((s) => s.worker_id === workers[0]!.id)!.id;
  const adaSlip = slips.find((s) => s.worker_id === workers[1]!.id)!.id;
  const batchId = randomUUID();
  const body = Buffer.from(`MUSA IBRAHIM,${MUSA_NUMBER}\r\n`, "utf8");
  ok(
    await admin.storage
      .from("payroll-files")
      .upload(`${orgId}/${runId}/${batchId}.csv`, body, { contentType: "text/csv" }),
    "store",
  );
  ok(
    await owner.rpc("make_payout_batch", {
      p_organisation_id: orgId,
      p_run_id: runId,
      p_batch_id: batchId,
      p_bank_format: "generic-csv",
      p_file_sha256: "c".repeat(64),
      p_file_bytes: body.byteLength,
      p_items: [
        {
          payslip_id: musaSlip,
          position: 1,
          status: "pending",
          left_out_reason: null,
          bank_name: "GTBank",
          bank_code: "058",
          account_name: "MUSA IBRAHIM",
          bank_account_last4: MUSA_NUMBER.slice(-4),
          bank_detail_change_id: null,
          amount_kobo: String(NET),
        },
        {
          payslip_id: adaSlip,
          position: 2,
          status: "left_out",
          left_out_reason: "no_bank_details",
          bank_name: null,
          bank_code: null,
          account_name: null,
          bank_account_last4: null,
          bank_detail_change_id: null,
          amount_kobo: "0",
        },
      ] as Json,
    }),
    "bank file",
  );
  ok(
    await owner.rpc("payout_file_download", { p_organisation_id: orgId, p_batch_id: batchId }),
    "download",
  );
  ok(
    await finance.rpc("release_payroll_run", {
      p_organisation_id: orgId,
      p_run_id: runId,
      p_batch_id: batchId,
      p_file_sha256: "c".repeat(64),
    }),
    "release",
  );
  return { runId, adaId: workers[1]!.id };
}

test("the owner makes a supplementary file for a left-out worker; Finance confirms it", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const owner = await createOwner("psup-owner", `Lagoon Guards ${uniqueSuffix()}`);
  const finance = await createAccount("psup-fin", "Adaeze Okafor");
  await addMembership(owner.orgId, finance.userId, "finance" as Role);
  const ownerClient = await signedIn(owner.email, owner.password);
  const financeClient = await signedIn(finance.email, finance.password);
  const { runId, adaId } = await seedReleasedRun(
    owner.orgId,
    ownerClient,
    owner.userId,
    financeClient,
    finance.userId,
  );
  const runPath = `/app/payroll/${runId}`;

  // Ada's details are now in force (as an applied, second-approved bank change would leave them).
  ok(
    await adminClient()
      .from("workers")
      .update({
        bank_name: "Access Bank",
        account_name: "ADA OBI",
        bank_code: "044",
        bank_account_enc: encryptAccount(ADA_NUMBER, owner.orgId, adaId),
        bank_account_last4: ADA_NUMBER.slice(-4),
      })
      .eq("id", adaId),
    "Ada's details",
  );

  await page.setViewportSize({ width: 1440, height: 1000 });
  await signInViaUi(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });
  await page.goto(`${runPath}?step=pay`);
  const outstanding = page.getByTestId("outstanding");
  await expect(outstanding.getByRole("heading", { name: "1 outstanding · ₦109,400" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(outstanding.getByTestId("outstanding-row")).toContainText("Ada Obi");
  await expect(outstanding.getByTestId("outstanding-row")).toContainText("ready");

  const make = page.getByRole("form", { name: "Make a supplementary file" });
  await make.getByRole("button", { name: "Make a supplementary file" }).click();
  await expect(make.getByTestId("run-preview")).toContainText("1 worker, ₦109,400", {
    timeout: 30_000,
  });
  await make.getByRole("button", { name: "Make the file" }).click();
  await expect(page.getByTestId("supplementary-count")).toHaveText("1", { timeout: 30_000 });
  await page.reload();
  await expect(page.getByTestId("supplementary-total")).toHaveText("₦109,400");
  await expect(page.getByTestId("supplementary-sha")).toHaveText(/^[0-9a-f]{64}$/);
  await expect(page.getByTestId("supplementary-row")).toContainText("•••• 7891");
  await expect(page.locator("body")).not.toContainText(ADA_NUMBER);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByTestId("supplementary-file")
      .getByRole("button", { name: "Download the file" })
      .click(),
  ]);
  const file = readFileSync((await download.path())!, "utf8");
  expect(file).toContain(`ADA OBI,${ADA_NUMBER},044,Access Bank,109400.00,`);
  expect(file).not.toContain(MUSA_NUMBER);

  // The owner prepared the run (and made the file), so they can't confirm it.
  await page.reload();
  const own = page.getByRole("form", { name: "Confirm the supplementary file" });
  await own.getByRole("button", { name: "I uploaded it to the bank" }).click();
  await expect(own.getByRole("alert")).toContainText("a different person must confirm", {
    timeout: 30_000,
  });

  const fin = await browser.newPage();
  await fin.setViewportSize({ width: 1440, height: 1000 });
  await signInViaUi(fin, finance.email, finance.password);
  await expect(fin).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });
  await fin.goto(`${runPath}?step=pay`);
  const confirm = fin.getByRole("form", { name: "Confirm the supplementary file" });
  await confirm.getByRole("button", { name: "I uploaded it to the bank" }).click();
  await expect(confirm.getByTestId("run-preview")).toContainText("1 worker, ₦109,400", {
    timeout: 30_000,
  });
  await confirm.getByRole("button", { name: "Confirm it went to the bank" }).click();
  await expect(fin.getByRole("heading", { name: "0 outstanding · ₦0" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(fin.getByText("Supplementary files paid")).toBeVisible();
  await expect(fin.getByRole("form", { name: "Make a supplementary file" })).toHaveCount(0);

  await fin.setViewportSize({ width: 390, height: 900 });
  await fin.goto(`${runPath}?step=pay`);
  await expect(fin.getByTestId("outstanding")).toBeVisible();
  await expectNoHorizontalScroll(fin);
  await fin.close();
});
