import { randomUUID } from "node:crypto";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { adminClient, anonClient } from "../rls/helpers/supabase";
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
test.skip(
  !process.env.PII_ENCRYPTION_KEY,
  "Needs PII_ENCRYPTION_KEY set for the app under test (worker sign-in hashes the PIN with it)",
);

const PIN = "482913";

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function signedInPage(browser: Browser, account: TestAccount, baseURL?: string) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await signInViaUi(page, account.email, account.password);
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });
  return page;
}

/**
 * Slice 1.11 acceptance (owner decision 19): HR raises a staff ID correction with a reason,
 * can't approve it themselves, the owner (a second manager) approves it from Bank-detail
 * approvals, the worker page and the worker's own Me page show the new ID, and the old ID can't
 * be used again.
 */
test("a staff ID correction needs a second manager and the worker sees the new ID", async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const baseURL = testInfo.project.use.baseURL;
  const admin = adminClient();
  const suffix = uniqueSuffix();
  const owner = await createOwner("sid-owner", `Lekki Facility ${suffix}`);
  const hr = await createAccount("sid-hr", "Hauwa Bello");
  await addMembership(owner.orgId, hr.userId, "hr");

  const workerId = randomUUID();
  const typo = `LF-${suffix.slice(0, 4)}-O1`;
  const fixed = `LF-${suffix.slice(0, 4)}-01`;
  const name = `Musa Ibrahim ${suffix}`;
  const inserted = await admin.from("workers").insert({
    id: workerId,
    organisation_id: owner.orgId,
    staff_id: typo,
    first_name: "Musa",
    last_name: `Ibrahim ${suffix}`,
    job_title: "Cleaner",
    employment_type: "permanent",
    start_date: "2024-03-03",
  });
  expect(inserted.error).toBeNull();

  // --- HR raises the correction -------------------------------------------------------
  const hrPage = await signedInPage(browser, hr, baseURL);
  await hrPage.goto(`/app/people/${workerId}`);
  await expect(hrPage.getByRole("heading", { level: 1 })).toHaveText(name);
  await expect(hrPage.getByTestId("staff-id")).toHaveText(typo);
  await hrPage.locator("summary", { hasText: "Correct staff ID" }).click();
  const form = hrPage.getByRole("form", { name: "Correct staff ID" });
  // An ID already in use is refused on the field.
  await form.getByLabel("New staff ID", { exact: true }).fill(typo.toLowerCase());
  await form.getByLabel("Reason", { exact: true }).fill("Letter O typed for zero at import");
  await form.getByRole("button", { name: "Send for approval" }).click();
  await expect(hrPage.getByText("That is the staff ID they already have.")).toBeVisible({
    timeout: 15_000,
  });
  const retry = hrPage.getByRole("form", { name: "Correct staff ID" });
  await retry.getByLabel("New staff ID", { exact: true }).fill(fixed);
  await retry.getByLabel("Reason", { exact: true }).fill("Letter O typed for zero at import");
  await expectNoHorizontalScroll(hrPage);
  await retry.getByRole("button", { name: "Send for approval" }).click();

  const card = hrPage.getByRole("article", { name: `Staff ID correction for ${name}` });
  await expect(card).toContainText("Waiting for approval", { timeout: 15_000 });
  await expect(card.getByTestId("staff-id-change")).toHaveText(`${typo} → ${fixed}`);
  await expect(card).toContainText("You raised this correction, so someone else approves it.");
  await expect(card.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(hrPage.getByTestId("staff-id")).toHaveText(typo);
  await expectNoHorizontalScroll(hrPage);

  // --- The owner approves from the approvals list ---------------------------------------
  const ownerPage = await signedInPage(browser, owner, baseURL);
  await ownerPage.goto("/app/people/approvals");
  const pending = ownerPage.getByRole("article", { name: `Staff ID correction for ${name}` });
  await expect(pending).toContainText("Waiting for your approval");
  await expect(pending).toContainText("Letter O typed for zero at import");
  await expectNoHorizontalScroll(ownerPage);
  await pending.getByRole("button", { name: "Approve" }).click();
  // Decided, it leaves the waiting list.
  await expect(pending).toHaveCount(0, { timeout: 15_000 });

  await hrPage.reload();
  await expect(hrPage.getByTestId("staff-id")).toHaveText(fixed);
  await expect(
    hrPage.getByRole("article", { name: `Staff ID correction for ${name}` }),
  ).toContainText("Applied");

  // The audit log keeps before and after.
  const { data: audit } = await admin
    .from("audit_log")
    .select("before, after, actor_id")
    .eq("entity_id", workerId)
    .eq("action", "workers.update");
  expect(audit).toEqual([
    expect.objectContaining({
      actor_id: owner.userId,
      before: expect.objectContaining({ staff_id: typo }),
      after: expect.objectContaining({ staff_id: fixed }),
    }),
  ]);
  // The old ID can never be given to anyone else in the company.
  const reuse = await admin.from("workers").insert({
    organisation_id: owner.orgId,
    staff_id: typo,
    first_name: "Someone",
    last_name: "Else",
    employment_type: "permanent",
    start_date: "2024-03-03",
  });
  expect(reuse.error?.code).toBe("MLSI3");

  // --- The worker sees the new ID on Me -------------------------------------------------
  const ownerClient = anonClient();
  await ownerClient.auth.signInWithPassword({ email: owner.email, password: owner.password });
  const invite = await ownerClient.rpc("create_worker_invites", {
    p_organisation_id: owner.orgId,
    p_worker_ids: [workerId],
    p_sent_via: "print",
  });
  expect(invite.error).toBeNull();
  const phone = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  const w = await phone.newPage();
  await w.goto(`/m/invite/${invite.data![0]!.token}`);
  await expect(w.getByTestId("invite-identity")).toContainText(`staff ID ${fixed}`);
  await w.getByLabel("New PIN").fill(PIN);
  await w.getByLabel("Type the PIN again").fill(PIN);
  await w.getByRole("checkbox", { name: /I have read this/ }).check();
  await w.getByRole("button", { name: "Set PIN and sign in" }).click();
  await expect(w).toHaveURL(/\/m$/, { timeout: 15_000 });
  await w.goto("/m/me");
  await expect(w.getByText(new RegExp(`Cleaner · ${fixed}`))).toBeVisible();
  await expectNoHorizontalScroll(w);
  await phone.close();
});
