import { randomBytes, randomUUID } from "node:crypto";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { adminClient, pgClient } from "../rls/helpers/supabase";
import {
  NEEDS_SUPABASE,
  addMembership,
  createAccount,
  createOwner,
  signInViaUi,
  supabaseReady,
  uniqueSuffix,
  type TestAccount,
} from "./helpers/auth";

test.skip(!supabaseReady, NEEDS_SUPABASE);
// The new account number is encrypted by the app, so the server under test needs a key.
test.skip(
  !process.env.PII_ENCRYPTION_KEY,
  "Needs PII_ENCRYPTION_KEY set for the app under test (any throwaway 32-byte base64 key)",
);

const NEW_NUBAN = "2000009153";

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function signedInPage(browser: Browser, account: TestAccount): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInViaUi(page, account.email, account.password);
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });
  return page;
}

/** Moves an approved change's 72-hour hold into the past, as if three days had gone by. */
async function endHold(workerId: string) {
  const db = await pgClient();
  try {
    await db.query("begin");
    await db.query(
      "alter table public.bank_detail_changes disable trigger bank_detail_changes_before_update",
    );
    const { rowCount } = await db.query(
      `update public.bank_detail_changes
       set decided_at = now() - interval '73 hours', applies_after = now() - interval '1 hour'
       where worker_id = $1 and status = 'approved'`,
      [workerId],
    );
    await db.query(
      "alter table public.bank_detail_changes enable trigger bank_detail_changes_before_update",
    );
    await db.query("commit");
    expect(rowCount).toBe(1);
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    await db.end();
  }
}

/**
 * Slice 1.7 acceptance: a change raised by HR (user A) stays pending, A can't approve it,
 * finance (user B) approves it, the worker keeps the old account through the 72-hour hold, and
 * after it the new account shows, masked for an operations manager.
 */
test("a bank change needs a second approver and applies 72 hours later", async ({ browser }) => {
  test.setTimeout(180_000);
  const suffix = uniqueSuffix();
  // Setup is finished below, once the worker is on file: after setup, a new worker row can't
  // carry bank details at all.
  const owner = await createOwner("bank-owner", `Apapa Guards ${suffix}`, { setupDone: false });
  const hr = await createAccount("bank-hr", "Hauwa Bello");
  const finance = await createAccount("bank-finance", "Femi Adeyemi");
  const ops = await createAccount("bank-ops", "Obinna Okafor");
  await addMembership(owner.orgId, hr.userId, "hr");
  await addMembership(owner.orgId, finance.userId, "finance");
  await addMembership(owner.orgId, ops.userId, "ops_manager");

  // A worker already paid into an Access Bank account ending 1234.
  const workerId = randomUUID();
  const name = `Musa Ibrahim ${suffix}`;
  const { error } = await adminClient()
    .from("workers")
    .insert({
      id: workerId,
      organisation_id: owner.orgId,
      staff_id: "MO-0114",
      first_name: "Musa",
      last_name: `Ibrahim ${suffix}`,
      employment_type: "permanent",
      start_date: "2024-03-03",
      bank_name: "Access Bank",
      account_name: "Musa Ibrahim",
      bank_account_enc: `\\x${randomBytes(48).toString("hex")}`,
      bank_account_last4: "1234",
    });
  expect(error).toBeNull();
  const db = await pgClient();
  await db.query("update public.organisations set setup_completed_at = now() where id = $1", [
    owner.orgId,
  ]);
  await db.end();

  // --- HR (user A) raises the change ---------------------------------------------------
  const hrPage = await signedInPage(browser, hr);
  await hrPage.goto(`/app/people/${workerId}`);
  await expect(hrPage.getByRole("heading", { level: 1 })).toHaveText(name);
  await expect(hrPage.getByTestId("bank-account")).toHaveText("••••1234");
  const form = hrPage.getByRole("form", { name: "Change bank details" });
  await form.getByLabel("New bank name", { exact: true }).fill("GTBank");
  await form.getByLabel("New account name", { exact: true }).fill("Musa Ibrahim");
  await form.getByLabel("New account number", { exact: true }).fill(NEW_NUBAN);
  await form.getByLabel("Reason", { exact: true }).fill("Moved to GTBank, letter on file");
  await expectNoHorizontalScroll(hrPage);
  await form.getByRole("button", { name: "Send for approval" }).click();

  // The page refreshes with the request in place of the form.
  const card = hrPage.getByRole("article", { name: `Bank change for ${name}` });
  await expect(card).toContainText("Waiting for approval", { timeout: 15_000 });
  await expect(hrPage.getByRole("form", { name: "Change bank details" })).toHaveCount(0);
  await expect(card.getByTestId("bank-change-account")).toHaveText("••••9153");
  await expect(card).toContainText("You raised this request, so someone else approves it.");
  await expect(card.getByRole("button", { name: "Approve" })).toHaveCount(0);
  // Nothing has changed on the worker.
  await expect(hrPage.getByTestId("bank-account")).toHaveText("••••1234");
  await expectNoHorizontalScroll(hrPage);

  // The People header shows the waiting change; the approvals list offers A no approval.
  await hrPage.goto("/app/people");
  await expect(hrPage.getByTestId("bank-approvals-badge")).toHaveText("1 bank change to approve");
  await hrPage.getByTestId("bank-approvals-badge").click();
  await expect(hrPage).toHaveURL(/\/app\/people\/approvals$/);
  await expect(hrPage.getByRole("heading", { level: 1 })).toHaveText(
    "1 bank change waiting for approval",
  );
  await expect(hrPage.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expectNoHorizontalScroll(hrPage);

  // --- Finance (user B) approves --------------------------------------------------------
  const financePage = await signedInPage(browser, finance);
  await financePage.goto("/app/people/approvals");
  const pending = financePage.getByRole("article", { name: `Bank change for ${name}` });
  await expect(pending).toContainText("Waiting for your approval");
  await expect(pending).toContainText("Moved to GTBank, letter on file");
  await expect(pending).toContainText("Access Bank ••••1234");
  // Finance may check the new number in full; the reveal is audited.
  await pending.getByRole("button", { name: "Show account number" }).click();
  await expect(pending.getByTestId("bank-change-account")).toHaveText(NEW_NUBAN, {
    timeout: 15_000,
  });
  await expectNoHorizontalScroll(financePage);
  await pending.getByRole("button", { name: "Approve" }).click();

  // The request moves to "On hold"; during the hold the worker keeps the old account.
  const onHold = financePage
    .getByRole("region", { name: /On hold/ })
    .getByRole("article", { name: `Bank change for ${name}` });
  await expect(onHold).toContainText("Approved, on hold", { timeout: 15_000 });
  await expect(financePage.getByRole("heading", { level: 1 })).toHaveText(
    "No bank changes waiting",
  );
  await expect(onHold.getByTestId("bank-change-hold")).toContainText("Approved by Femi Adeyemi");
  await expect(onHold.getByRole("button", { name: "Stop this change" })).toBeVisible();
  await hrPage.goto(`/app/people/${workerId}`);
  await expect(hrPage.getByTestId("bank-account")).toHaveText("••••1234");
  await financePage.context().close();

  // --- 72 hours later ------------------------------------------------------------------
  await endHold(workerId);

  // An operations manager sees the new account, masked, with no way to show it in full.
  const opsPage = await signedInPage(browser, ops);
  await opsPage.goto(`/app/people/${workerId}`);
  await expect(opsPage.getByTestId("bank-account")).toHaveText("••••9153", { timeout: 15_000 });
  await expect(opsPage.getByRole("button", { name: "Show account number" })).toHaveCount(0);
  await expectNoHorizontalScroll(opsPage);
  await opsPage.context().close();

  await hrPage.reload();
  await expect(hrPage.getByTestId("bank-account")).toHaveText("••••9153");
  await expect(hrPage.getByRole("article", { name: `Bank change for ${name}` })).toContainText(
    "In use",
  );
  await hrPage.context().close();

  // The audit log has the request, the decision and the change, never the number.
  const { data: audit } = await adminClient()
    .from("audit_log")
    .select("action, before, after")
    .eq("organisation_id", owner.orgId);
  const actions = (audit ?? []).map((row) => row.action);
  expect(actions).toEqual(
    expect.arrayContaining([
      "bank_detail_changes.insert",
      "bank_detail_changes.update",
      "workers.personal_data",
      "pii.reveal",
    ]),
  );
  expect(JSON.stringify(audit)).not.toContain(NEW_NUBAN);
});
