/**
 * Slice 1.12: team invites for managers. The owner invites an HR manager from Settings → Team,
 * the HR manager signs in from the invite link and accepts, then approves a bank-detail change
 * the owner raised: the two-person rule working with two real managers. A second test covers a
 * new manager who creates their account from the invite (confirming their address before they
 * choose a password, slice 1.13), and a signed-in wrong account.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { adminClient, anonClient, pgClient } from "../rls/helpers/supabase";
import {
  NEEDS_SUPABASE,
  createAccount,
  createOwner,
  followEmailLink,
  latestEmailTo,
  newPassword,
  signInViaUi,
  supabaseReady,
  uniqueEmail,
  uniqueSuffix,
  type TestAccount,
} from "./helpers/auth";

test.skip(!supabaseReady, NEEDS_SUPABASE);

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

/** Fills the sign-in form already on screen (keeps its ?next=). */
async function signInHere(page: Page, email: string, password: string) {
  await page.getByRole("textbox", { name: "Work email" }).fill(email);
  await page.getByRole("textbox", { name: "Password" }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/**
 * The owner invites `email` as `role` from Settings → Team; returns the link's path. With email
 * off (development) the page shows the link once. Where a send is attempted and fails (the e2e
 * build runs as production without a Resend key) the link is never shown, so the test asks for a
 * fresh one the way the Resend button does, through the owner's own session.
 */
async function invite(
  page: Page,
  owner: TestAccount & { orgId: string },
  email: string,
  role: string,
  label: string,
): Promise<string> {
  await page.goto("/app/settings/team");
  const form = page.getByRole("form", { name: "Invite a manager" });
  await form.getByLabel("Work email").fill(email);
  await form.getByLabel("Role").selectOption({ label });
  await form.getByRole("button", { name: "Send invite" }).click();
  await expect(page.getByRole("status").filter({ hasText: `for ${email} as ${role}` })).toBeVisible(
    { timeout: 15_000 },
  );
  const shown = page.getByTestId("team-invite-link");
  let link: string;
  if ((await shown.count()) > 0) {
    link = await shown.inputValue();
  } else {
    await expect(
      page.getByRole("status").filter({ hasText: "Use Resend to try again" }),
    ).toBeVisible();
    const client = anonClient();
    const signIn = await client.auth.signInWithPassword({
      email: owner.email,
      password: owner.password,
    });
    expect(signIn.error).toBeNull();
    const { data: row } = await adminClient()
      .from("membership_invites")
      .select("id")
      .eq("organisation_id", owner.orgId)
      .eq("email", email.toLowerCase())
      .is("accepted_at", null)
      .is("revoked_at", null)
      .single();
    const { data, error } = await client.rpc("resend_membership_invite", {
      p_organisation_id: owner.orgId,
      p_invite_id: row!.id,
    });
    expect(error).toBeNull();
    link = `http://localhost/join/${data![0]!.token}`;
  }
  expect(link).toMatch(/\/join\/[0-9a-f]{64}$/);
  return new URL(link).pathname;
}

test("owner invites HR, who accepts and approves the owner's bank change", async ({ browser }) => {
  test.setTimeout(180_000);
  const suffix = uniqueSuffix();
  const owner = await createOwner("team-owner", `Apapa Guards ${suffix}`, { setupDone: false });
  const hr = await createAccount("team-hr", "Hauwa Bello");

  // A worker already paid into an account ending 1234 (written as an applied change leaves it).
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

  // --- The owner opens Settings → Team and invites HR ---------------------------------------
  const ownerPage = await signedInPage(browser, owner);
  await ownerPage.goto("/app/settings");
  await ownerPage.getByRole("link", { name: /^Team/ }).click();
  await expect(ownerPage).toHaveURL(/\/app\/settings\/team$/);
  await expect(ownerPage.getByRole("heading", { level: 1 })).toHaveText("Team");
  await expect(ownerPage.getByText(/^1 manager · 0 pending invites/)).toBeVisible();
  const ownerRow = ownerPage.getByRole("listitem", { name: "Test Owner" });
  await expect(ownerRow.getByTestId("team-member-role")).toHaveText("Owner");
  await expect(ownerRow).toContainText("You can't change your own role.");
  await expectNoHorizontalScroll(ownerPage);

  const joinPath = await invite(ownerPage, owner, hr.email, "HR", "HR");
  const pending = ownerPage.getByRole("listitem", { name: hr.email.toLowerCase() });
  await expect(pending).toContainText("Pending until");
  await expect(ownerPage.getByText(/^1 manager · 1 pending invite/)).toBeVisible();
  await expectNoHorizontalScroll(ownerPage);

  // --- HR opens the link signed out, signs in and accepts -----------------------------------
  const hrPage = await (await browser.newContext()).newPage();
  await hrPage.goto(joinPath);
  await expect(hrPage.getByRole("heading", { level: 1 })).toHaveText(`Join ${owner.orgName}`);
  await expect(hrPage.getByText(`invited ${hr.email.toLowerCase()} to join as HR`)).toBeVisible();
  await expectNoHorizontalScroll(hrPage);
  await hrPage.getByRole("link", { name: "Sign in to accept" }).click();
  await expect(hrPage).toHaveURL(/\/sign-in\?next=/);
  await signInHere(hrPage, hr.email, hr.password);
  await expect(hrPage).toHaveURL(new RegExp(`${joinPath}$`), { timeout: 15_000 });
  await hrPage.getByRole("button", { name: "Accept and join" }).click();
  await expect(hrPage).toHaveURL(/\/app$/, { timeout: 15_000 });

  // The link worked once.
  await hrPage.goto(joinPath);
  await expect(hrPage.getByRole("alert").filter({ hasText: "already been used" })).toBeVisible();
  // Like the other auth pages: a back arrow home and a 44px button to sign in.
  await expect(hrPage.getByTestId("back-link")).toHaveAttribute("href", "/");
  const toSignIn = hrPage.getByRole("link", { name: "Go to sign in" });
  expect((await toSignIn.boundingBox())?.height).toBeGreaterThanOrEqual(44);

  // HR is not an owner or admin: no Team page.
  await hrPage.goto("/app/settings/team");
  await expect(hrPage).toHaveURL(/\/no-access$/);

  // --- The owner raises a bank change; HR approves it ---------------------------------------
  await ownerPage.goto(`/app/people/${workerId}`);
  const form = ownerPage.getByRole("form", { name: "Change bank details" });
  await form.getByLabel("New bank name", { exact: true }).fill("GTBank");
  await form.getByLabel("New account name", { exact: true }).fill("Musa Ibrahim");
  await form.getByLabel("New account number", { exact: true }).fill(NEW_NUBAN);
  await form.getByLabel("Reason", { exact: true }).fill("Moved to GTBank, letter on file");
  await form.getByRole("button", { name: "Send for approval" }).click();
  const card = ownerPage.getByRole("article", { name: `Bank change for ${name}` });
  await expect(card).toContainText("Waiting for approval", { timeout: 15_000 });
  await expect(card).toContainText("You raised this request, so someone else approves it.");
  await expect(card.getByRole("button", { name: "Approve" })).toHaveCount(0);

  await hrPage.goto("/app/people/approvals");
  const waiting = hrPage.getByRole("article", { name: `Bank change for ${name}` });
  await expect(waiting).toContainText("Waiting for your approval");
  await waiting.getByRole("button", { name: "Approve" }).click();
  const onHold = hrPage
    .getByRole("region", { name: /On hold/ })
    .getByRole("article", { name: `Bank change for ${name}` });
  await expect(onHold).toContainText("Approved, on hold", { timeout: 15_000 });
  await expect(onHold.getByTestId("bank-change-hold")).toContainText("Approved by Hauwa Bello");
  await expectNoHorizontalScroll(hrPage);

  // --- The owner changes HR's role, then removes them ---------------------------------------
  await ownerPage.goto("/app/settings/team");
  await expect(ownerPage.getByText(/^2 managers · 0 pending invites/)).toBeVisible();
  const hrRow = ownerPage.getByRole("listitem", { name: "Hauwa Bello" });
  await expect(hrRow.getByTestId("team-member-role")).toHaveText("HR");
  await hrRow.getByLabel("Role", { exact: true }).selectOption({ label: "Finance" });
  await hrRow.getByRole("button", { name: "Save role" }).click();
  await expect(hrRow.getByTestId("team-member-role")).toHaveText("Finance", { timeout: 15_000 });
  await expectNoHorizontalScroll(ownerPage);

  await hrRow.getByRole("button", { name: "Remove" }).click();
  await hrRow.getByRole("button", { name: "Yes, remove" }).click();
  await expect(ownerPage.getByRole("listitem", { name: "Hauwa Bello" })).toHaveCount(0, {
    timeout: 15_000,
  });
  await hrPage.goto("/app/people/approvals");
  await expect(hrPage).toHaveURL(/\/no-access$/);

  // Every team change is in the audit log with the owner as actor.
  const { data: audit } = await adminClient()
    .from("audit_log")
    .select("action, actor_id, before, after")
    .eq("organisation_id", owner.orgId)
    .in("action", ["membership_invites.insert", "memberships.update", "memberships.delete"]);
  const byAction = (action: string) => (audit ?? []).filter((a) => a.action === action);
  expect(byAction("membership_invites.insert")[0]?.actor_id).toBe(owner.userId);
  expect(byAction("memberships.update")[0]).toMatchObject({
    actor_id: owner.userId,
    before: expect.objectContaining({ role: "hr" }),
    after: expect.objectContaining({ role: "finance" }),
  });
  expect(byAction("memberships.delete")[0]?.actor_id).toBe(owner.userId);
  expect(JSON.stringify(audit)).not.toContain("token_hash");
});

test("a new manager creates their account from the invite; a wrong account is told so", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await createOwner("team-owner2", `Coastline Cleaning ${uniqueSuffix()}`);
  const outsider = await createAccount("team-outsider", "Obi Outsider");
  const email = uniqueEmail("team-new");
  const password = newPassword();

  const ownerPage = await signedInPage(browser, owner);
  const joinPath = await invite(ownerPage, owner, email, "Finance", "Finance");

  // Someone else signed in on this browser (with no company yet): told to switch account.
  const page = await (await browser.newContext()).newPage();
  await signInViaUi(page, outsider.email, outsider.password);
  await expect(page).toHaveURL(/\/no-access$/, { timeout: 15_000 });
  await expect(page.getByTestId("no-access-invited")).toBeVisible();
  await page.goto(joinPath);
  await expect(
    page.getByRole("alert").filter({ hasText: `This invite is for ${email.toLowerCase()}` }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out and switch account" }).click();
  await expect(page).toHaveURL(/\/sign-in\?next=/);

  // Back to the invite signed out: create the account with the invited address.
  await page.goto(joinPath);
  const signUp = page.getByRole("form", { name: "Create your account" });
  await expect(signUp.getByLabel("Work email")).toHaveValue(email.toLowerCase());
  // Slice 1.13: no password (or name) until the address is confirmed.
  await expect(signUp.getByLabel("Password")).toHaveCount(0);
  await signUp.getByRole("button", { name: "Email me a link" }).click();
  await expect(page).toHaveURL(/\/check-email\?sent=invite$/, { timeout: 15_000 });

  // The confirmation link signs them in and brings them back to the invite, where they choose
  // their password and accept.
  await followEmailLink(page, await latestEmailTo(email));
  await expect(page).toHaveURL(new RegExp(`${joinPath}$`), { timeout: 15_000 });
  await page.getByLabel("Your full name").fill("Femi Adeyemi");
  await page.getByLabel("Choose a password").fill(password);
  await page.getByRole("button", { name: "Set password and join" }).click();
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });

  // No company was created for them: they joined the owner's, as finance.
  const { data } = await adminClient()
    .from("memberships")
    .select("organisation_id, role, user_id")
    .eq("organisation_id", owner.orgId)
    .eq("role", "finance");
  expect(data).toHaveLength(1);
  const { count } = await adminClient()
    .from("memberships")
    .select("id", { count: "exact", head: true })
    .eq("user_id", data![0]!.user_id);
  expect(count).toBe(1);
  await expectNoHorizontalScroll(page);
});
