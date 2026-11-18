/**
 * Slice 1.13: several owners and hand-over. The only owner invites a second owner from Settings →
 * Team (alone: there is one owner). The second owner joins from the link: they give only their
 * name, confirm their address from the email, then choose their password and accept. The first
 * owner then steps down, which waits until the second owner approves it.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";

import { adminClient, anonClient } from "../rls/helpers/supabase";
import {
  NEEDS_SUPABASE,
  createOwner,
  followEmailLink,
  latestEmailTo,
  newPassword,
  signInViaUi,
  supabaseReady,
  uniqueEmail,
  uniqueSuffix,
  type TestOwner,
} from "./helpers/auth";

test.skip(!supabaseReady, NEEDS_SUPABASE);

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function signedInPage(browser: Browser, email: string, password: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signInViaUi(page, email, password);
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });
  return page;
}

/**
 * The link of the owner invite for `email`. With email off the page shows it; where a send is
 * attempted and fails (the e2e build runs as production without a Resend key) the test asks for
 * a fresh link through the owner's own session, as the Resend button does.
 */
async function ownerInviteLink(page: Page, owner: TestOwner, email: string): Promise<string> {
  const shown = page.getByTestId("team-invite-link");
  if ((await shown.count()) > 0) return new URL(await shown.inputValue()).pathname;
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
    .eq("role", "owner")
    .is("accepted_at", null)
    .is("revoked_at", null)
    .single();
  const { data, error } = await client.rpc("resend_membership_invite", {
    p_organisation_id: owner.orgId,
    p_invite_id: row!.id,
  });
  expect(error).toBeNull();
  return `/join/${data![0]!.token}`;
}

async function roleOf(orgId: string, userId: string) {
  const { data } = await adminClient()
    .from("memberships")
    .select("role")
    .eq("organisation_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  return data?.role ?? null;
}

test("an owner invites a second owner, who sets their password after confirming; then hands over", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await createOwner("own-first", `Lekki Shield ${uniqueSuffix()}`);
  const email = uniqueEmail("own-second");
  const password = newPassword();

  // --- The only owner invites someone as owner, alone --------------------------------------
  const ownerPage = await signedInPage(browser, owner.email, owner.password);
  await ownerPage.goto("/app/settings/team");
  const ownRow = ownerPage.getByRole("listitem", { name: "Test Owner" });
  await expect(ownRow).toContainText("You are the only owner");
  const form = ownerPage.getByRole("form", { name: "Invite a manager" });
  await form.getByLabel("Work email").fill(email);
  await form.getByLabel("Role").selectOption({ label: "Owner" });
  await form.getByRole("button", { name: "Send invite" }).click();
  await expect(
    ownerPage.getByRole("status").filter({ hasText: `for ${email.toLowerCase()} as Owner` }),
  ).toBeVisible({ timeout: 15_000 });
  await expectNoHorizontalScroll(ownerPage);
  const joinPath = await ownerInviteLink(ownerPage, owner, email);

  // --- The invitee gives only their name; no password before the email is confirmed ---------
  const page = await (await browser.newContext()).newPage();
  await page.goto(joinPath);
  await expect(page.getByText(`invited ${email.toLowerCase()} to join as Owner`)).toBeVisible();
  const signUp = page.getByRole("form", { name: "Create your account" });
  await expect(signUp.getByLabel("Work email")).toHaveValue(email.toLowerCase());
  await expect(signUp.getByLabel("Password")).toHaveCount(0);
  await signUp.getByLabel("Your full name").fill("Bola Adeyemi");
  await signUp.getByRole("button", { name: "Email me a link" }).click();
  await expect(page).toHaveURL(/\/check-email\?sent=invite$/, { timeout: 15_000 });
  await expectNoHorizontalScroll(page);

  // The confirmation link brings them back to the invite, where they choose their password.
  await followEmailLink(page, await latestEmailTo(email));
  await expect(page).toHaveURL(new RegExp(`${joinPath}$`), { timeout: 15_000 });
  const accept = page.getByRole("form", { name: "Accept the invite" });
  await accept.getByLabel("Choose a password").fill(password);
  await accept.getByRole("button", { name: "Set password and join" }).click();
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });

  const { data: second } = await adminClient()
    .from("memberships")
    .select("user_id, role")
    .eq("organisation_id", owner.orgId)
    .eq("role", "owner");
  expect(second).toHaveLength(2);
  const secondId = second!.find((m) => m.user_id !== owner.userId)!.user_id;

  // The password they chose works.
  const secondPage = await signedInPage(browser, email, password);

  // --- The first owner asks to step down; nothing changes until the second owner approves ---
  await ownerPage.goto("/app/settings/team");
  const stepDown = ownerPage.getByRole("form", { name: "Step down as owner" });
  await stepDown.getByLabel("Step down to").selectOption({ label: "Admin" });
  await stepDown.getByRole("button", { name: "Ask to step down" }).click();
  await expect(
    ownerPage.getByRole("status").filter({ hasText: "Waiting for another owner to approve" }),
  ).toBeVisible({ timeout: 15_000 });
  expect(await roleOf(owner.orgId, owner.userId)).toBe("owner");
  await ownerPage.reload();
  const mine = ownerPage.getByTestId("owner-change");
  await expect(mine).toContainText("Test Owner steps down to Admin");
  await expect(mine.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(mine.getByRole("button", { name: "Withdraw" })).toBeVisible();

  await secondPage.goto("/app/settings/team");
  const waiting = secondPage.getByTestId("owner-change");
  await expect(waiting).toContainText("Waiting for your approval");
  await expectNoHorizontalScroll(secondPage);
  await waiting.getByRole("button", { name: "Approve" }).click();
  await expect(secondPage.getByRole("status").filter({ hasText: "Approved" })).toBeVisible({
    timeout: 15_000,
  });
  expect(await roleOf(owner.orgId, owner.userId)).toBe("admin");
  expect(await roleOf(owner.orgId, secondId)).toBe("owner");

  // Every step is in the audit log: the request, its approval and the role change.
  const { data: audit } = await adminClient()
    .from("audit_log")
    .select("action, actor_id")
    .eq("organisation_id", owner.orgId)
    .in("action", ["owner_changes.insert", "owner_changes.update", "memberships.update"]);
  expect(audit).toEqual(
    expect.arrayContaining([
      { action: "owner_changes.insert", actor_id: owner.userId },
      { action: "owner_changes.update", actor_id: secondId },
      { action: "memberships.update", actor_id: secondId },
    ]),
  );
});
