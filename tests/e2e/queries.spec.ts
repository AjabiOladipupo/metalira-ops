/**
 * Slice 4.6 acceptance (docs/PHASE_4.md 4.6): a line manager raises a lateness query with a
 * reply-by date on the employee's HR file, the worker replies on the phone at /m/queries, and both
 * show on the HR file, at 390px and 1440px.
 */
import { expect, test, type Page } from "@playwright/test";

import { addDays, formatDate, lagosToday } from "@/lib/dates";

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

const PIN = "482913";

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("a line manager raises a lateness query, the worker replies on the phone, both show on the HR file", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-390", "One run covers both widths.");
  test.setTimeout(180_000);
  const admin = adminClient();
  const suffix = uniqueSuffix();
  const owner = await createOwner("sq-owner", `Gatekeepers ${suffix}`);
  const manager = await createAccount("sq-lm", "Kola Adebayo");
  await addMembership(owner.orgId, manager.userId, "line_manager");
  const { data: membership } = await admin
    .from("memberships")
    .select("id")
    .eq("organisation_id", owner.orgId)
    .eq("user_id", manager.userId)
    .single();
  const worker = await admin
    .from("workers")
    .insert({
      organisation_id: owner.orgId,
      staff_id: `SQ-${suffix.slice(0, 4)}`,
      first_name: "Musa",
      last_name: `Ibrahim ${suffix}`,
      employment_type: "permanent",
      start_date: "2024-03-03",
      line_manager_membership_id: membership!.id,
    })
    .select("id")
    .single();
  expect(worker.error).toBeNull();
  const workerId = worker.data!.id;

  const ownerClient = anonClient();
  await ownerClient.auth.signInWithPassword({ email: owner.email, password: owner.password });
  const invite = await ownerClient.rpc("create_worker_invites", {
    p_organisation_id: owner.orgId,
    p_worker_ids: [workerId],
    p_sent_via: "print",
  });
  expect(invite.error).toBeNull();
  const token = invite.data![0]!.token;

  // The line manager raises the query from the HR file at phone width.
  await page.setViewportSize({ width: 390, height: 844 });
  await signInViaUi(page, manager.email, manager.password);
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });
  await page.goto(`/app/people/${workerId}`);
  const hrFile = page.getByRole("region", { name: "HR file" });
  await expect(hrFile.getByTestId("hr-queries-empty")).toBeVisible({ timeout: 15_000 });
  await expect(hrFile.getByTestId("hr-file-leave-placeholder")).toBeVisible();
  const replyBy = addDays(lagosToday(), 3);
  const form = page.getByRole("form", { name: /New query for Musa/ });
  await form.getByLabel("Type").selectOption("lateness");
  await form.getByLabel("Subject").fill("Lateness on 23 October");
  await form
    .getByLabel("What happened")
    .fill("You clocked in at 06:41 for your 06:00 shift at Gate A. Please explain.");
  await form.getByLabel("Reply needed by").fill(replyBy);
  await form.getByRole("button", { name: "Send query" }).click();
  await expect(hrFile.getByRole("status")).toContainText(
    `Query sent. Reply needed by ${formatDate(replyBy)}.`,
    { timeout: 15_000 },
  );
  await page.reload();
  const card = page.getByTestId("hr-query");
  await expect(card).toHaveCount(1, { timeout: 15_000 });
  await expect(card).toContainText("Lateness · Lateness on 23 October");
  await expect(card).toContainText("Awaiting reply");
  await expectNoHorizontalScroll(page);

  // The worker sets a PIN from the invite, sees the banner on home and replies.
  const phone = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: { width: 390, height: 844 },
  });
  const w = await phone.newPage();
  await w.goto(`/m/invite/${token}`);
  await w.getByLabel("New PIN").fill(PIN);
  await w.getByLabel("Type the PIN again").fill(PIN);
  await w.getByRole("checkbox", { name: /I have read this/ }).check();
  await w.getByRole("button", { name: "Set PIN and sign in" }).click();
  await expect(w).toHaveURL(/\/m$/, { timeout: 15_000 });
  const banner = w.getByTestId("home-query-banner");
  await expect(banner).toContainText("1 query from Kola Adebayo · reply by", { timeout: 15_000 });
  await banner.click();
  await expect(w).toHaveURL(/\/m\/queries$/);
  const mine = w.getByTestId("my-query");
  await expect(mine.getByTestId("my-query-reply-by")).toContainText("Reply by");
  await expect(mine.getByRole("heading", { name: "Lateness on 23 October" })).toBeVisible();
  await mine
    .getByRole("textbox", { name: "Your reply" })
    .fill("The BRT was stopped at Mile 2 because of an accident. I called Kola at 05:50.");
  await mine.getByRole("button", { name: "Send reply" }).click();
  await expect(w.getByTestId("query-reply-sent")).toBeVisible({ timeout: 15_000 });
  await expectNoHorizontalScroll(w);
  // The inbox has the notice, without the query's text.
  await w.goto("/m/inbox");
  await expect(w.getByText("New query: Lateness on 23 October")).toBeVisible({ timeout: 15_000 });
  await expect(w.getByText(/06:41/)).toHaveCount(0);
  await phone.close();

  // Both show on the HR file, at 1440px, for the line manager and for the owner.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await expect(card).toContainText("Replied", { timeout: 15_000 });
  await expect(card.getByTestId("hr-query-reply")).toContainText(
    "The BRT was stopped at Mile 2 because of an accident.",
  );
  await expectNoHorizontalScroll(page);

  const ownerContext = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const ownerPage = await ownerContext.newPage();
  await ownerPage.setViewportSize({ width: 1440, height: 900 });
  await signInViaUi(ownerPage, owner.email, owner.password);
  await expect(ownerPage).toHaveURL(/\/app/, { timeout: 15_000 });
  await ownerPage.goto(`/app/people/${workerId}`);
  const ownerCard = ownerPage.getByTestId("hr-query");
  await expect(ownerCard).toContainText("Lateness on 23 October", { timeout: 15_000 });
  await expect(ownerCard.getByTestId("hr-query-reply")).toContainText("Mile 2");

  // The owner closes it with an outcome.
  await ownerCard.getByText("Close query", { exact: true }).first().click();
  const closeForm = ownerCard.getByRole("form", { name: "Close query" });
  await closeForm.getByLabel("Outcome").fill("Explanation accepted. No further action.");
  await closeForm.getByRole("button", { name: "Close query" }).click();
  // The page refreshes: the card shows Closed with the outcome, and no more actions.
  await expect(ownerCard).toContainText("Closed", { timeout: 15_000 });
  await expect(ownerCard).toContainText("Explanation accepted. No further action.");
  await expect(ownerCard.getByRole("form")).toHaveCount(0);
  await ownerContext.close();
});
