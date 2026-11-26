/**
 * Slice U.4: self-onboarding invites. The owner invites a guard by email; the guard opens the link
 * on a phone (390px) and sends their own mock details; HR approves; the guard shows in People
 * with the Guard role. A Finance invite becomes a Finance member once approved.
 *
 * The e2e build runs as production without a Resend key, so invite emails fail and the link is
 * never shown; the test asks for a fresh link through the owner's own session, as the Resend
 * button does (the same approach as team-invites.spec.ts).
 */
import { expect, test, type Browser, type Page } from "@playwright/test";

import { CONSENT_NOTICES } from "@/lib/messages/consent";

import { adminClient, anonClient } from "../rls/helpers/supabase";
import {
  NEEDS_SUPABASE,
  addMembership,
  createAccount,
  createOwner,
  signInViaUi,
  supabaseReady,
  uniqueEmail,
  uniqueSuffix,
  type TestAccount,
  type TestOwner,
} from "./helpers/auth";

test.skip(!supabaseReady, NEEDS_SUPABASE);

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function signedInPage(browser: Browser, account: TestAccount): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signInViaUi(page, account.email, account.password);
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });
  return page;
}

/** Invites from People > Onboard, then returns the link path and the invite's id. */
async function inviteFromUi(
  page: Page,
  owner: TestOwner,
  email: string,
  roleLabel: string,
): Promise<{ path: string; inviteId: string }> {
  await page.goto("/app/people");
  await page.getByRole("link", { name: "Onboard" }).click();
  await expect(page).toHaveURL(/\/app\/people\/onboarding$/);
  const form = page.getByRole("form", { name: "Invite to onboard" });
  await expect(form.getByTestId("emails-left")).toContainText("emails left today");
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Role").selectOption({ label: roleLabel });
  await form.getByRole("button", { name: "Send invite" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: `for ${email} as ${roleLabel}` }),
  ).toBeVisible({ timeout: 15_000 });

  const { data: row } = await adminClient()
    .from("onboarding_invites")
    .select("id")
    .eq("organisation_id", owner.orgId)
    .eq("email", email)
    .single();
  const client = anonClient();
  const signIn = await client.auth.signInWithPassword({
    email: owner.email,
    password: owner.password,
  });
  expect(signIn.error).toBeNull();
  const { data, error } = await client.rpc("resend_self_onboarding_invite", {
    p_organisation_id: owner.orgId,
    p_invite_id: row!.id,
  });
  expect(error).toBeNull();
  return { path: `/onboard/${data![0]!.token}`, inviteId: row!.id };
}

test("owner invites a guard, who sends their details from a phone; HR approves", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const suffix = uniqueSuffix();
  const owner = await createOwner("so-owner", `Lekki Guards ${suffix}`);
  const hr = await createAccount("so-hr", "Hauwa Bello");
  await addMembership(owner.orgId, hr.userId, "hr");
  const guardEmail = uniqueEmail("so-guard");
  const lastName = `Okafor ${suffix}`;

  const ownerPage = await signedInPage(browser, owner);
  const { path, inviteId } = await inviteFromUi(ownerPage, owner, guardEmail, "Guard");
  await expect(ownerPage.getByTestId("onboarding-invite").first()).toContainText("Guard");

  // --- The guard, signed out, on a 390px phone ---------------------------------------------
  const phone = await (
    await browser.newContext({ viewport: { width: 390, height: 844 } })
  ).newPage();
  await phone.goto(path);
  await expect(phone.getByRole("heading", { level: 1 })).toHaveText(`Join ${owner.orgName}`);
  await expect(phone.getByText("Onboarding · Guard")).toBeVisible();
  // Only the company and the role: the address isn't shown.
  await expect(phone.getByText(guardEmail)).toHaveCount(0);
  await expectNoHorizontalScroll(phone);

  const form = phone.getByRole("form", { name: "Your details" });
  await form.getByLabel("Your email address").fill(guardEmail.toUpperCase());
  await form.getByLabel("First name", { exact: true }).fill("Chidi");
  await form.getByLabel("Last name", { exact: true }).fill(lastName);
  await form.getByLabel("Phone number").fill("0803 555 0101");
  await form.getByLabel("Date of birth").fill("1995-06-15");
  await form.getByLabel("Home address").fill("4 Admiralty Way, Lekki");
  await form.getByLabel("Emergency contact name").fill("Ada Okafor");
  await form.getByLabel("Emergency contact phone").fill("08055550202");
  await form.getByLabel("NIN (optional)").fill("12345678901");
  await form.getByLabel("Bank (optional)").selectOption({ label: "GTBank (Guaranty Trust Bank)" });
  await form.getByLabel("Account number").fill("0123456789");
  await form.getByLabel("Name on the account").fill(`Chidi ${lastName}`);
  await form.getByLabel(CONSENT_NOTICES.location.agree).check();
  await form.getByRole("button", { name: "Send my details" }).click();
  await expect(phone.getByRole("status")).toContainText("waiting for HR review", {
    timeout: 15_000,
  });
  await expectNoHorizontalScroll(phone);

  // Nothing is active yet.
  const before = await adminClient().from("workers").select("id").eq("email", guardEmail);
  expect(before.data).toEqual([]);

  // --- HR reviews and approves --------------------------------------------------------------
  const hrPage = await signedInPage(browser, hr);
  await hrPage.goto("/app/people/onboarding");
  await expect(hrPage.getByText("Waiting for HR review").first()).toBeVisible();
  await hrPage.goto(`/app/people/onboarding/${inviteId}`);
  await expect(hrPage.getByRole("heading", { level: 1 })).toHaveText(`Chidi ${lastName}`);
  // Masked: last 4 only.
  await expect(hrPage.getByText("•••• 8901")).toBeVisible();
  await expect(hrPage.getByText("12345678901")).toHaveCount(0);
  const approve = hrPage.getByRole("form", { name: "Approve" });
  await approve.getByRole("button", { name: "Approve" }).click();
  await expect(hrPage.getByRole("status")).toContainText("Approved as Guard.", {
    timeout: 20_000,
  });
  await expect(hrPage.getByRole("status")).toContainText("second person");

  // --- The guard is in People with the Guard role -------------------------------------------
  const { data: worker } = await adminClient()
    .from("workers")
    .select("id, job_title, status")
    .eq("email", guardEmail)
    .single();
  expect(worker).toMatchObject({ job_title: "Guard", status: "active" });
  await hrPage.goto("/app/people");
  const row = hrPage.getByRole("row").filter({ hasText: lastName });
  await expect(row).toContainText("Guard");

  // The link was single use.
  await phone.goto(path);
  await expect(phone.getByRole("status")).toContainText("approved");
});

test("a Finance invite becomes a Finance member once approved", async ({ browser }) => {
  test.setTimeout(150_000);
  const suffix = uniqueSuffix();
  const owner = await createOwner("so-owner2", `Ikoyi Cleaners ${suffix}`);
  const person = await createAccount("so-fin", "Ngozi Eze");

  const ownerPage = await signedInPage(browser, owner);
  const { path, inviteId } = await inviteFromUi(
    ownerPage,
    owner,
    person.email.toLowerCase(),
    "Finance",
  );

  // The invitee signs in with the invited address and comes back to the invite.
  const page = await (
    await browser.newContext({ viewport: { width: 390, height: 844 } })
  ).newPage();
  await page.goto(`/sign-in?next=${encodeURIComponent(path)}`);
  await page.getByRole("textbox", { name: "Work email" }).fill(person.email);
  await page.getByRole("textbox", { name: "Password" }).fill(person.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${path}$`), { timeout: 15_000 });
  await expect(page.getByText("Onboarding · Finance")).toBeVisible();
  const form = page.getByRole("form", { name: "Your details" });
  await form.getByLabel("First name", { exact: true }).fill("Ngozi");
  await form.getByLabel("Last name", { exact: true }).fill(`Eze ${suffix}`);
  await form.getByLabel("Phone number").fill("08033330303");
  await form.getByRole("button", { name: "Send my details" }).click();
  await expect(page.getByRole("status")).toContainText("waiting for HR review", {
    timeout: 15_000,
  });
  const none = await adminClient()
    .from("memberships")
    .select("id")
    .eq("organisation_id", owner.orgId)
    .eq("user_id", person.userId);
  expect(none.data).toEqual([]);

  await ownerPage.goto(`/app/people/onboarding/${inviteId}`);
  await ownerPage
    .getByRole("form", { name: "Approve" })
    .getByRole("button", { name: "Approve" })
    .click();
  await expect(ownerPage.getByRole("status")).toContainText("Approved as Finance.", {
    timeout: 20_000,
  });
  const { data: membership } = await adminClient()
    .from("memberships")
    .select("role")
    .eq("organisation_id", owner.orgId)
    .eq("user_id", person.userId)
    .single();
  expect(membership?.role).toBe("finance");
});
