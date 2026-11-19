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
import { NEAR_ENDING, NO_MATCH_ENDING, enterBankAccount } from "./helpers/bank";

test.skip(!supabaseReady, NEEDS_SUPABASE);
// The account number is encrypted by the app, so the server under test needs a key.
test.skip(
  !process.env.PII_ENCRYPTION_KEY,
  "Needs PII_ENCRYPTION_KEY set for the app under test (any throwaway 32-byte base64 key)",
);

const NUBAN = "0123454410";

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function signedInPage(
  browser: Browser,
  account: TestAccount,
  landing: RegExp = /\/app$/,
): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInViaUi(page, account.email, account.password);
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
  return page;
}

const GTBANK = "GTBank (Guaranty Trust Bank)";

/** Picks the bank and types the number; the bank gives the account name (slice 2.3b). */
async function fillAccount(page: Page, search: string, bankName: string, number: string) {
  const form = page.getByRole("form", { name: /bank account|Change the account/ });
  const result = await enterBankAccount(form, { search, bankName, number });
  return { form, result };
}

/** Moves an approved account's 72-hour hold into the past, as if three days had gone by. */
async function endHold(orgId: string) {
  const db = await pgClient();
  try {
    await db.query("begin");
    await db.query(
      "alter table public.organisation_bank_accounts disable trigger organisation_bank_accounts_before_update",
    );
    const { rowCount } = await db.query(
      `update public.organisation_bank_accounts
       set decided_at = now() - interval '73 hours', applies_after = now() - interval '1 hour'
       where organisation_id = $1 and status = 'approved'`,
      [orgId],
    );
    await db.query(
      "alter table public.organisation_bank_accounts enable trigger organisation_bank_accounts_before_update",
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
 * Slice 2.3 acceptance: the owner asks for the account, it stays pending (the owner can't
 * approve it), finance approves it, it waits out the hold, and then it shows masked in Settings.
 */
test("the owner asks, finance approves, and the account shows masked after the hold", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const suffix = uniqueSuffix();
  const owner = await createOwner("cb-owner", `Coastline Guards ${suffix}`);
  const finance = await createAccount("cb-finance", "Femi Adeyemi");
  await addMembership(owner.orgId, finance.userId, "finance");

  // --- The owner raises the request ----------------------------------------------------
  const ownerPage = await signedInPage(browser, owner);
  await ownerPage.goto("/app/settings");
  await ownerPage.getByRole("link", { name: /Where clients pay/ }).click();
  await expect(ownerPage).toHaveURL(/\/app\/settings\/bank-account$/);
  await expect(ownerPage.getByRole("link", { name: "Back to Settings" })).toBeVisible();
  await expect(ownerPage.getByTestId("company-bank-none")).toBeVisible();

  const { form, result } = await fillAccount(ownerPage, "gtb", GTBANK, NUBAN);
  // The bank's name, read-only, compared with the company's name.
  await expect(result.getByTestId("bank-lookup-name")).toHaveText(
    `COASTLINE GUARDS ${suffix.toUpperCase()}`,
  );
  await expect(result.getByTestId("name-check-status")).toHaveText("Name matches");
  await expect(form.getByLabel("Account name", { exact: true })).toHaveCount(0);
  await form.getByRole("button", { name: "Review" }).click();
  const preview = form.getByTestId("company-bank-preview");
  await expect(preview).toContainText(
    `${GTBANK} ••••4410 · COASTLINE GUARDS ${suffix.toUpperCase()}`,
  );
  await expect(preview).toContainText("other than you must approve it");
  await expect(preview).not.toContainText(NUBAN);
  await expectNoHorizontalScroll(ownerPage);
  await form.getByRole("button", { name: "Send for approval" }).click();
  // The page refreshes with the request waiting (the form goes: one open request at a time).
  const waiting = ownerPage.getByTestId("company-bank-account").filter({ hasText: "New account" });
  await expect(waiting).toHaveAttribute("data-status", "pending");
  // The requester gets no approve button, only withdraw.
  await expect(waiting.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(waiting.getByRole("button", { name: "Withdraw request" })).toBeVisible();

  // --- Finance approves ---------------------------------------------------------------
  const financePage = await signedInPage(browser, finance);
  await financePage.goto("/app/settings/bank-account");
  const card = financePage.getByTestId("company-bank-account").filter({ hasText: "New account" });
  await expect(card.getByText("Waiting for your approval")).toBeVisible();
  // The approver sees the bank's name check before deciding.
  await expect(card.getByTestId("name-check-status")).toHaveText("Name matches");
  await expect(card.getByTestId("test-lookup")).toBeVisible();
  // Finance checks the full number, audited.
  await card.getByRole("button", { name: "Show account number" }).click();
  await expect(card.getByTestId("company-bank-number")).toHaveText(NUBAN);
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(financePage.getByTestId("company-bank-decided")).toContainText(
    "Invoices show the account ending 4410",
  );
  await financePage.reload();
  await expect(financePage.getByTestId("company-bank-hold")).toContainText("left");

  const { data: reveals } = await adminClient()
    .from("audit_log")
    .select("action")
    .eq("organisation_id", owner.orgId)
    .eq("action", "pii.reveal")
    .eq("entity", "organisation_bank_accounts");
  expect(reveals).toHaveLength(1);

  // --- After the hold: masked in Settings > Company and on the bank page ------------------
  await endHold(owner.orgId);
  await ownerPage.goto("/app/settings/bank-account");
  const inUse = ownerPage.getByTestId("company-bank-account").filter({ hasText: "Account in use" });
  await expect(inUse).toHaveAttribute("data-status", "active");
  await expect(inUse.getByTestId("company-bank-number")).toHaveText("••••4410");
  await expectNoHorizontalScroll(ownerPage);

  await ownerPage.goto("/app/settings/company");
  await expect(ownerPage.getByTestId("rail-status")).toHaveText(
    `${GTBANK} ••••4410 · COASTLINE GUARDS ${suffix.toUpperCase()}`,
  );
});

/** The first account while setup is unfinished: the owner alone, at once, audited. */
test("an owner adds the first account alone during setup", async ({ browser }) => {
  test.setTimeout(120_000);
  const suffix = uniqueSuffix();
  const owner = await createOwner("cb-first", `Greenfield Cleaning ${suffix}`, {
    setupDone: false,
  });
  const page = await signedInPage(browser, owner, /\/app\/setup\//);

  await page.goto("/app/setup/invoices");
  await expect(page.getByTestId("rail-status")).toHaveText("No account yet");
  await page.getByRole("link", { name: "Add bank account" }).click();
  await expect(page).toHaveURL(/\/app\/settings\/bank-account\?from=setup$/);

  const { form } = await fillAccount(page, "access", "Access Bank", "0690001234");
  await form.getByRole("button", { name: "Review" }).click();
  await expect(form.getByTestId("company-bank-preview")).toContainText("needs no second approver");
  await form.getByRole("button", { name: "Add account" }).click();
  await expect(page.getByTestId("company-bank-sent")).toContainText("ending 1234");

  // Back to setup: the account shows masked on step 3.
  await page.getByTestId("back-link").click();
  await expect(page).toHaveURL(/\/app\/setup\/invoices$/);
  await expect(page.getByTestId("rail-status")).toHaveText(
    `Access Bank ••••1234 · GREENFIELD CLEANING ${suffix.toUpperCase()}`,
  );
  await expectNoHorizontalScroll(page);

  const { data: audit } = await adminClient()
    .from("audit_log")
    .select("action")
    .eq("organisation_id", owner.orgId)
    .eq("action", "billing.bank_account_single_approver");
  expect(audit).toHaveLength(1);
});

/**
 * Slice 2.3b: a close match needs a reason, which the approver sees; an account in someone
 * else's name can't be sent at all.
 */
test("a close match needs a reason the approver sees; no match is refused", async ({ browser }) => {
  test.setTimeout(150_000);
  const suffix = uniqueSuffix();
  const owner = await createOwner("cb-near", `Harbour Security ${suffix}`);
  const finance = await createAccount("cb-near-fin", "Femi Adeyemi");
  await addMembership(owner.orgId, finance.userId, "finance");
  const page = await signedInPage(browser, owner);
  await page.goto("/app/settings/bank-account");

  // No match: someone else's name; the form says so and won't go to review.
  const noMatch = await fillAccount(page, "zenith", "Zenith Bank", `012345678${NO_MATCH_ENDING}`);
  await expect(noMatch.result.getByTestId("name-check-status")).toHaveText("Name doesn't match");
  await expect(noMatch.result).toContainText("can't be used");
  await noMatch.form.getByRole("button", { name: "Review" }).click();
  await expect(
    noMatch.form.getByRole("alert").filter({ hasText: "doesn't match your company" }),
  ).toBeVisible();
  await expect(noMatch.form.getByTestId("company-bank-preview")).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  // Close match: a reason is needed before review.
  const form = noMatch.form;
  const number = form.getByLabel("Account number", { exact: true });
  await number.fill(`012345678${NEAR_ENDING}`);
  const near = form.getByTestId("bank-lookup-result");
  await expect(near.getByTestId("name-check-status")).toHaveText("Close match");
  await expect(near).toContainText(`Expected: Harbour Security ${suffix}`);
  await form.getByRole("button", { name: "Review" }).click();
  await expect(
    form.getByRole("alert").filter({ hasText: "Say why this is the right account" }),
  ).toBeVisible();
  await form
    .getByLabel("Why is this the right account?", { exact: true })
    .fill("The bank shortened our name; letter on file");
  await form.getByRole("button", { name: "Review" }).click();
  await form.getByRole("button", { name: "Send for approval" }).click();
  await expect(
    page.getByTestId("company-bank-account").filter({ hasText: "New account" }),
  ).toHaveAttribute("data-status", "pending");

  // Finance sees the close match, both names and the reason.
  const financePage = await signedInPage(browser, finance);
  await financePage.goto("/app/settings/bank-account");
  const card = financePage.getByTestId("company-bank-account").filter({ hasText: "New account" });
  await expect(card.getByTestId("name-check-status")).toHaveText("Close match");
  await expect(card).toContainText(`HARBOUR SECURIT`);
  await expect(card).toContainText(`Expected: Harbour Security ${suffix}`);
  await expect(card.getByTestId("name-check-reason")).toContainText(
    "The bank shortened our name; letter on file",
  );
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(financePage.getByTestId("company-bank-decided")).toContainText("ending");
});
