/**
 * Slice 1.13: a password counts only once it was chosen after the address was confirmed. Here
 * someone signed the victim's address up with their own password (straight through the Auth
 * API) and the victim confirmed it. That password opens nothing: signing in with it sends an
 * email link instead (accepting an invite with it is refused in the database, tests/rls/owners).
 * The victim chooses their own password from the link, and the old one stops working.
 */
import { expect, test } from "@playwright/test";

import { adminClient } from "../rls/helpers/supabase";
import {
  NEEDS_SUPABASE,
  followEmailLink,
  latestEmailTo,
  newPassword,
  signInViaUi,
  supabaseReady,
  uniqueEmail,
} from "./helpers/auth";

test.skip(!supabaseReady, NEEDS_SUPABASE);

test("a password set before the address was confirmed opens nothing", async ({ browser }) => {
  test.setTimeout(120_000);
  const email = uniqueEmail("prereg");
  const attackerPassword = newPassword();
  // Pre-registered by someone else, then confirmed by the mailbox owner: no password_set_at.
  const { data: created, error } = await adminClient().auth.admin.createUser({
    email,
    password: attackerPassword,
    email_confirm: true,
    user_metadata: { full_name: "Victim Person" },
  });
  expect(error).toBeNull();

  // The attacker signs in with their password: no session, an email link goes to the victim.
  const attacker = await (await browser.newContext()).newPage();
  await signInViaUi(attacker, email, attackerPassword);
  await expect(attacker).toHaveURL(/\/check-email\?sent=password$/, { timeout: 15_000 });
  await attacker.goto("/app");
  await expect(attacker).toHaveURL(/\/sign-in$/);

  // The victim opens the link, chooses their own password, and the old one stops working.
  const victim = await (await browser.newContext()).newPage();
  await followEmailLink(victim, await latestEmailTo(email));
  await expect(victim).toHaveURL(/\/set-password\?next=/, { timeout: 15_000 });
  const mine = newPassword();
  await victim.getByLabel("Choose a password").fill(mine);
  await victim.getByRole("button", { name: "Save password" }).click();
  await expect(victim).toHaveURL(/\/(app|no-access)/, { timeout: 15_000 });

  const again = await (await browser.newContext()).newPage();
  await signInViaUi(again, email, attackerPassword);
  await expect(
    again.getByRole("alert").filter({ hasText: "don't match an account" }),
  ).toBeVisible();

  const { data: user } = await adminClient().auth.admin.getUserById(created.user!.id);
  expect(typeof user.user?.app_metadata?.password_set_at).toBe("string");
});
