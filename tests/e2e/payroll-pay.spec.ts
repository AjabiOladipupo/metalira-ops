/**
 * Slice 5.4 accept line, in the browser: the owner prepares and submits October 2026 for two
 * golden workers with bank details on file, and Finance approves it. On the Pay step the owner
 * makes the bank file: a worker whose stored last 4 digits don't match their number is refused by
 * name; once fixed, the control totals (count, total, SHA-256) equal the run's net pay and count.
 * The owner downloads it through a 60-second link and can't release it; Finance releases, and the
 * release publishes a payslip PDF and notice per worker (slice 5.5). At 1440px, then 390px with
 * no horizontal scroll.
 * (Isolation, the bucket, insert-only rows and the SQL rules are in tests/rls/payouts.test.ts; the
 * file's bytes and the log are in tests/unit/payroll/bank-file*.test.ts.)
 */
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

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
test.skip(
  !process.env.PII_ENCRYPTION_KEY,
  "Needs PII_ENCRYPTION_KEY set for the app under test (any throwaway 32-byte base64 key)",
);

const NUMBERS = ["0123456789", "8012345671"] as const;

/**
 * The stored form of an account number for workers.bank_account_enc of the worker, as
 * src/server/crypto/pii.ts writes it (version 1, IV, tag, ciphertext; the place bound in the AAD).
 */
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

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Two golden workers (Musa Ibrahim, Ibrahim Sani) with bank details; the second's last 4 wrong. */
async function seedWorkers(orgId: string): Promise<string[]> {
  const admin = adminClient();
  const ids: string[] = [];
  for (const [i, w] of golden.workers.slice(0, 2).entries()) {
    const [first, last] = w.name.split(" ");
    const id = randomUUID();
    const number = NUMBERS[i]!;
    const { error } = await admin.from("workers").insert({
      id,
      organisation_id: orgId,
      staff_id: `PAY-${i + 1}-${randomUUID().slice(0, 4)}`,
      first_name: first!,
      last_name: last!,
      employment_type: "permanent",
      start_date: "2025-01-06",
      tax_state: "Lagos",
      annual_rent_declared_kobo: w.annual_rent * 100,
      bank_name: "GTBank",
      account_name: w.name.toUpperCase(),
      bank_code: "058",
      bank_account_enc: encryptAccount(number, orgId, id),
      // The second worker's stored last 4 digits are wrong at first.
      bank_account_last4: i === 1 ? "0000" : number.slice(-4),
    });
    if (error) throw new Error(error.message);
    const gross = w.gross * 100;
    const basic = gross / 2;
    const housing = (gross * 3) / 10;
    const rate = await admin.from("pay_rates").insert({
      organisation_id: orgId,
      worker_id: id,
      pay_type: "monthly",
      basic_kobo: basic,
      housing_kobo: housing,
      transport_kobo: gross - basic - housing,
      other_allowances_kobo: 0,
      effective_from: "2025-01-06",
    });
    if (rate.error) throw new Error(rate.error.message);
    ids.push(id);
  }
  return ids;
}

async function goToStep(page: Page, label: RegExp, step: string) {
  await page.getByRole("link", { name: label }).first().click();
  await expect(page).toHaveURL(new RegExp(`step=${step}`));
}

test("Finance makes the bank file with control totals, downloads it and releases the run", async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const owner = await createOwner("ppay-owner", `Harbour Guards ${uniqueSuffix()}`);
  const finance = await createAccount("ppay-fin", "Adaeze Okafor");
  await addMembership(owner.orgId, finance.userId, "finance");
  const [, saniId] = await seedWorkers(owner.orgId);
  // Net pay ₦104,740 + ₦115,570 (the golden figures).
  expect(golden.workers[0]!.net + golden.workers[1]!.net).toBe(220_310);

  // The owner prepares the run, acknowledges every anomaly and submits it.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signInViaUi(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });
  await page.goto("/app/payroll");
  const create = page.getByRole("form", { name: "Prepare a payroll run" });
  await create.getByLabel("Pay period").selectOption("2026-09-20");
  await create.getByRole("button", { name: "Preview the run" }).click();
  await expect(create.getByTestId("run-preview")).toContainText("for 2 workers", {
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

  // Finance approves.
  const fin = await browser.newPage();
  await fin.setViewportSize({ width: 1440, height: 1000 });
  await signInViaUi(fin, finance.email, finance.password);
  await expect(fin).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });
  await fin.goto(`${runPath}?step=submit`);
  const approval = fin.getByRole("form", { name: "Approve the run" });
  await approval.getByRole("button", { name: "Check and approve" }).click();
  await expect(approval.getByTestId("run-preview")).toContainText("Approves", { timeout: 30_000 });
  await approval.getByRole("button", { name: "Confirm and approve" }).click();
  await expect(fin.getByTestId("posted-note")).toContainText("Approved", { timeout: 30_000 });

  // The owner (who prepared the run) makes the file on the Pay step: the preview, then the
  // last-4 mismatch refused by name. (P prepares and makes the file; F approves and releases.)
  await page.goto(`${runPath}?step=pay`);
  await expect(page.getByRole("heading", { level: 2, name: "Make the bank file" })).toBeVisible();
  const make = page.getByRole("form", { name: "Make the bank file" });
  await make.getByRole("button", { name: "Preview the file" }).click();
  await expect(make.getByTestId("run-preview")).toContainText("2 workers, ₦220,310; 0 left out", {
    timeout: 30_000,
  });
  await make.getByRole("button", { name: "Make the file" }).click();
  await expect(make.getByRole("alert")).toContainText(
    "The account number on file for Ibrahim Sani doesn't match its last 4 digits",
    { timeout: 30_000 },
  );
  await expect(make.getByRole("alert")).not.toContainText(NUMBERS[1]);

  // Fixed (as a checked bank change would), the file is made with its control totals.
  const fixed = await adminClient()
    .from("workers")
    .update({ bank_account_last4: NUMBERS[1].slice(-4) })
    .eq("id", saniId!);
  expect(fixed.error).toBeNull();
  await make.getByRole("button", { name: "Preview the file" }).click();
  await expect(make.getByTestId("run-preview")).toContainText("2 workers", { timeout: 30_000 });
  await make.getByRole("button", { name: "Make the file" }).click();
  await expect(page.getByTestId("bank-file-count")).toHaveText("2", { timeout: 30_000 });
  await page.reload();
  await expect(page.getByTestId("bank-file-count")).toHaveText("2");
  await expect(page.getByTestId("bank-file-total")).toHaveText("₦220,310");
  await expect(page.getByTestId("bank-file-sha")).toHaveText(/^[0-9a-f]{64}$/);
  await expect(page.getByTestId("bank-file-row")).toHaveCount(2);
  await expect(page.getByRole("table", { name: "Workers in the bank file" })).toContainText(
    "•••• 5671",
  );
  await expect(page.getByRole("table", { name: "Workers in the bank file" })).not.toContainText(
    NUMBERS[1],
  );

  // Download: a 60-second link the browser opens at once.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download the file" }).click(),
  ]);
  const file = readFileSync((await download.path())!, "utf8");
  expect(
    file.startsWith("Beneficiary name,Account number,Bank code,Bank name,Amount,Narration\r\n"),
  ).toBe(true);
  expect(file).toContain(`MUSA IBRAHIM,${NUMBERS[0]},058,GTBank,104740.00,Salary Oct 2026 PAY-1-`);
  expect(file).toContain(`IBRAHIM SANI,${NUMBERS[1]},058,GTBank,115570.00,Salary Oct 2026 PAY-2-`);

  // The owner prepared the run and made the file, so they can't release it.
  await page.reload();
  const ownRelease = page.getByRole("form", { name: "Release the run" });
  await ownRelease.getByRole("button", { name: "I uploaded it to the bank" }).click();
  await expect(ownRelease.getByRole("alert")).toContainText("a different person must release it", {
    timeout: 30_000,
  });

  // Finance (the approver, who didn't make the file) releases.
  await fin.goto(`${runPath}?step=pay`);
  await expect(fin.getByTestId("bank-file-downloaded")).toContainText("downloaded by");
  const release = fin.getByRole("form", { name: "Release the run" });
  await release.getByRole("button", { name: "I uploaded it to the bank" }).click();
  await expect(release.getByTestId("run-preview")).toContainText("Releases October 2026 payroll", {
    timeout: 30_000,
  });
  await release.getByRole("button", { name: "Confirm and release" }).click();
  await expect(fin.getByTestId("released-note")).toContainText("Released", { timeout: 30_000 });
  await fin.reload();
  await expect(fin.getByTestId("released-note")).toContainText("by Adaeze Okafor");
  await expect(fin.getByRole("form", { name: "Release the run" })).toHaveCount(0);

  // The release publishes the payslips (slice 5.5): a PDF and a notice per worker.
  const runId = runPath.split("/").pop()!;
  await expect
    .poll(
      async () => {
        const docs = await adminClient()
          .from("payslip_documents")
          .select("payslip_id", { count: "exact", head: true })
          .eq("run_id", runId);
        return docs.count ?? 0;
      },
      { timeout: 60_000 },
    )
    .toBe(2);
  const { data: slips } = await adminClient().from("payslips").select("id").eq("run_id", runId);
  await expect
    .poll(
      async () => {
        const notices = await adminClient()
          .from("inbox_items")
          .select("id", { count: "exact", head: true })
          .in(
            "payslip_id",
            (slips ?? []).map((p) => p.id),
          );
        return notices.count ?? 0;
      },
      { timeout: 60_000 },
    )
    .toBe(2);
  await expect(fin.getByRole("form", { name: "Make a new bank file" })).toHaveCount(0);

  // 390px: the Pay step fits with no horizontal scroll.
  await fin.setViewportSize({ width: 390, height: 900 });
  await fin.goto(`${runPath}?step=pay`);
  await expect(fin.getByTestId("bank-file-total")).toBeVisible();
  await expectNoHorizontalScroll(fin);
  await fin.close();
});
