/**
 * Slice 5.5 accept line, in the browser: after release, Finance finishes publishing the October
 * 2026 run's payslips on the run's Payslips page (1440px), and Musa Ibrahim, on the phone
 * (390px), sees "You received ₦104,740" with ₦120,000 gross, PAYE ₦5,660 and pension ₦9,600,
 * and downloads the same figures as a PDF.
 *
 * The run is Musa's golden October payslip worked out by the engine and saved with the secret
 * key as the server does, submitted by the owner and approved by Finance through the real
 * functions. Release (slice 5.4's release_payroll_run) isn't on main yet, so the run is marked
 * released as the database owner with its guard off for that one update. TODO(5.4): release
 * through the Pay step instead, which then publishes the payslips on its own.
 */
import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import golden from "../../fixtures/october-2026-golden.json";
import { allocateKobo, parseNairaToKobo, sumKobo } from "@/lib/money";
import { grossToNet } from "@/lib/payroll/gross-to-net";
import { NTA_2025_V1 } from "@/lib/payroll/rule-set";
import { storedTrace } from "@/lib/payroll/trace";
import type { Json } from "@/types/db";

import { adminClient, anonClient, pgClient } from "../rls/helpers/supabase";
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

const PIN = "482913";
const SHA = "e".repeat(64);
const START = "2026-09-20";
const END = "2026-10-19";

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Musa's results document as the server saves it after running the engine. */
function musaResults(workerId: string, payRateId: string) {
  const musa = golden.workers.find((w) => w.name === "Musa Ibrahim")!;
  const gross = parseNairaToKobo(String(musa.gross));
  const [basic, housing, transport] = allocateKobo(gross, [5n, 3n, 2n]);
  const source = [{ kind: "pay_rate", id: payRateId, from: START, to: END }];
  const salary = (code: "basic" | "housing" | "transport", label: string, amount: bigint) => ({
    code,
    label,
    amountKobo: amount,
    pensionable: true,
    nhfBase: code === "basic",
    taxable: true,
    sources: [{ kind: "pay_rate" as const, id: payRateId, from: START, to: END }],
  });
  const r = grossToNet(
    {
      employmentType: "permanent",
      earnings: [
        salary("basic", "Basic", basic!),
        salary("housing", "Housing", housing!),
        salary("transport", "Transport", transport!),
      ],
      nhfOptIn: false,
      annualRentKobo: parseNairaToKobo(String(musa.annual_rent)),
      deductions: [],
      carriedDeductionKobo: 0n,
    },
    NTA_2025_V1,
    { itfApplies: false },
  );
  const k = (v: bigint) => v.toString();
  const totals = {
    gross_kobo: k(r.grossKobo),
    paye_kobo: k(r.payeKobo),
    pension_employee_kobo: k(r.pensionEmployeeKobo),
    pension_employer_kobo: k(r.pensionEmployerKobo),
    nhf_kobo: k(r.nhfKobo),
    other_deductions_kobo: k(r.otherDeductionsKobo),
    net_kobo: k(r.netKobo),
    nsitf_kobo: k(r.nsitfKobo),
    itf_kobo: k(r.itfKobo),
    employer_cost_kobo: k(r.employerCostKobo),
    carried_forward_kobo: k(r.carriedForwardKobo),
  };
  expect(sumKobo(r.lines.filter((l) => l.kind === "earning").map((l) => l.amountKobo))).toBe(gross);
  return {
    itf_applies: false,
    totals: { ...totals, worker_count: 1 },
    payslips: [
      {
        worker_id: workerId,
        employment_type: "permanent",
        tax_state: "Lagos",
        pfa_name: "Stanbic IBTC Pension",
        pay_rate_ids: [payRateId],
        days: { cycle: 30, rostered: 21, employed_rostered: 21, leave_deducted: 0 },
        ...totals,
        trace: storedTrace(r.trace),
        lines: r.lines.map((l) => ({
          code: l.code,
          kind: l.kind,
          label: l.label,
          amount_kobo: k(l.amountKobo),
          pensionable: l.pensionable,
          taxable: l.taxable,
          sources: l.kind === "earning" ? source : [],
        })),
      },
    ],
    anomalies: [],
  };
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc = await getDocument({ data: bytes, useSystemFonts: false }).promise;
  const parts: string[] = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const content = await (await doc.getPage(n)).getTextContent();
    parts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
  }
  await doc.destroy();
  return parts.join(" ").replace(/\s+/g, " ");
}

test("after release Musa Ibrahim reads his October payslip on the phone and downloads the PDF", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-390", "One run covers both widths.");
  test.setTimeout(240_000);
  const admin = adminClient();
  const suffix = uniqueSuffix();
  const owner = await createOwner("pslip-owner", `Coastline Guards ${suffix}`);
  const finance = await createAccount("pslip-fin", "Adaeze Okafor");
  await addMembership(owner.orgId, finance.userId, "finance");

  const worker = await admin
    .from("workers")
    .insert({
      organisation_id: owner.orgId,
      staff_id: `PS-${suffix.slice(0, 4)}`,
      first_name: "Musa",
      last_name: "Ibrahim",
      employment_type: "permanent",
      start_date: "2025-01-06",
      tax_state: "Lagos",
      pfa_name: "Stanbic IBTC Pension",
      annual_rent_declared_kobo: 36_000_000,
    })
    .select("id")
    .single();
  expect(worker.error).toBeNull();
  const workerId = worker.data!.id;
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
  expect(rate.error).toBeNull();

  // The owner prepares and submits; the server's results are saved with the secret key.
  const ownerClient = anonClient();
  await ownerClient.auth.signInWithPassword({ email: owner.email, password: owner.password });
  const created = await ownerClient.rpc("create_payroll_run", {
    p_organisation_id: owner.orgId,
    p_period_start: START,
  });
  expect(created.error).toBeNull();
  const runId = created.data!;
  const saved = await admin.rpc("save_payroll_results", {
    p_organisation_id: owner.orgId,
    p_run_id: runId,
    p_actor: owner.userId,
    p_results: musaResults(workerId, rate.data!.id) as unknown as Json,
    p_inputs_sha256: SHA,
  });
  expect(saved.error).toBeNull();
  expect(
    (
      await ownerClient.rpc("submit_payroll_run", {
        p_organisation_id: owner.orgId,
        p_run_id: runId,
      })
    ).error,
  ).toBeNull();

  // Finance approves after the server's input check.
  const financeClient = anonClient();
  await financeClient.auth.signInWithPassword({ email: finance.email, password: finance.password });
  const clock = await admin.rpc("payroll_clock");
  expect(
    (
      await admin.rpc("record_payroll_approval_check", {
        p_organisation_id: owner.orgId,
        p_run_id: runId,
        p_actor: finance.userId,
        p_inputs_sha256: SHA,
        p_read_started_at: clock.data!,
      })
    ).error,
  ).toBeNull();
  expect(
    (
      await financeClient.rpc("approve_payroll_run", {
        p_organisation_id: owner.orgId,
        p_run_id: runId,
      })
    ).error,
  ).toBeNull();

  // Released (TODO(5.4): the Pay step's "I uploaded it to the bank").
  const db = await pgClient();
  try {
    const { rows } = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'payroll_runs'
         and column_name in ('released_at', 'released_by')`,
    );
    await db.query("begin");
    await db.query("alter table public.payroll_runs disable trigger payroll_runs_guard");
    if (rows.length === 2) {
      await db.query(
        "update public.payroll_runs set status = 'released', released_at = now(), released_by = $2 where id = $1",
        [runId, finance.userId],
      );
    } else {
      await db.query("update public.payroll_runs set status = 'released' where id = $1", [runId]);
    }
    await db.query("alter table public.payroll_runs enable always trigger payroll_runs_guard");
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    await db.end();
  }

  const invite = await ownerClient.rpc("create_worker_invites", {
    p_organisation_id: owner.orgId,
    p_worker_ids: [workerId],
    p_sent_via: "print",
  });
  expect(invite.error).toBeNull();
  const token = invite.data![0]!.token;

  // Finance finishes publishing at 1440px: the PDF is made and Musa is told.
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInViaUi(page, finance.email, finance.password);
  await expect(page).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });
  await page.goto(`/app/payroll/${runId}/payslips`);
  const row = page.getByTestId("payslip-row");
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await expect(row).toContainText("Musa Ibrahim");
  await expect(row).toContainText("₦104,740");
  await expect(row).toContainText("Not made yet");
  const publish = page.getByTestId("publish-payslips");
  await publish.getByRole("button", { name: "Finish publishing" }).click();
  await expect(publish.getByRole("status")).toContainText(
    "1 of 1 payslip PDFs made, 1 workers told",
    {
      timeout: 60_000,
    },
  );
  await page.reload();
  await expect(row).toContainText("Made", { timeout: 15_000 });
  await expect(row.getByTestId("payslip-pdf")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Musa sets a PIN and opens Payslips on the phone.
  const phone = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: { width: 390, height: 844 },
    acceptDownloads: true,
  });
  const w = await phone.newPage();
  await w.goto(`/m/invite/${token}`);
  await w.getByLabel("New PIN").fill(PIN);
  await w.getByLabel("Type the PIN again").fill(PIN);
  await w.getByRole("checkbox", { name: /I have read this/ }).check();
  await w.getByRole("button", { name: "Set PIN and sign in" }).click();
  await expect(w).toHaveURL(/\/m$/, { timeout: 15_000 });
  // The inbox has the notice, without amounts.
  await w.goto("/m/inbox");
  await expect(w.getByText("Your October 2026 payslip is ready")).toBeVisible({ timeout: 15_000 });
  await expect(w.getByText(/₦/)).toHaveCount(0);

  await w.goto("/m/payslips");
  const slip = w.getByTestId("payslip");
  await expect(slip.getByTestId("payslip-net")).toHaveText("₦104,740", { timeout: 15_000 });
  await expect(slip).toContainText("You received · October 2026");
  await expect(slip).toContainText("Gross pay₦120,000");
  await expect(slip).toContainText("Income tax (PAYE)−₦5,660");
  await expect(slip).toContainText("Your pension, 8%−₦9,600");
  await expect(slip).toContainText("Total taken out−₦15,260");
  await expect(slip).toContainText("Pension, 10%₦12,000");
  await expect(slip).toContainText("Stanbic IBTC Pension");
  await expect(slip.getByTestId("payslip-rent")).toHaveText(
    "Tax uses your rent declaration of ₦360,000 a year.",
  );
  await expectNoHorizontalScroll(w);

  const [download] = await Promise.all([
    w.waitForEvent("download"),
    w.getByTestId("payslip-download").click(),
  ]);
  expect(download.suggestedFilename()).toBe("payslip-october-2026.pdf");
  const bytes = new Uint8Array(await readFile((await download.path())!));
  expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  const text = await pdfText(bytes);
  for (const figure of ["₦104,740.00", "₦120,000.00", "−₦5,660.00", "−₦9,600.00"]) {
    expect(text, figure).toContain(figure);
  }
  await phone.close();
});
