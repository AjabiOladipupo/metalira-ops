import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

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

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/**
 * Slice 1.11 acceptance (owner decision 18): a worker locked after 5 wrong PINs is unlocked by
 * their line manager from the worker page, the unlock is audited, and a held login (3 lockouts
 * in 24 hours) offers no unlock.
 */
test("a line manager unlocks a reportee's PIN lock from the worker page", async ({ page }) => {
  test.setTimeout(120_000);
  const admin = adminClient();
  const suffix = uniqueSuffix();
  const owner = await createOwner("unlock-owner", `Ikeja Cleaners ${suffix}`);
  const manager = await createAccount("unlock-lm", "Kola Adebayo");
  await addMembership(owner.orgId, manager.userId, "line_manager");
  const { data: membership } = await admin
    .from("memberships")
    .select("id")
    .eq("organisation_id", owner.orgId)
    .eq("user_id", manager.userId)
    .single();

  async function workerWithLogin(lastName: string, lock: { held: boolean }) {
    const workerId = randomUUID();
    const { error } = await admin.from("workers").insert({
      id: workerId,
      organisation_id: owner.orgId,
      staff_id: `UL-${suffix.slice(0, 4)}-${lastName.slice(0, 1)}`,
      first_name: "Musa",
      last_name: `${lastName} ${suffix}`,
      employment_type: "permanent",
      start_date: "2024-03-03",
      line_manager_membership_id: membership!.id,
    });
    expect(error).toBeNull();
    const login = await admin.auth.admin.createUser({
      email: `w-${workerId}@workers.metalira.invalid`,
      email_confirm: true,
      app_metadata: { login: "worker" },
    });
    expect(login.error).toBeNull();
    const now = Date.now();
    const cred = await admin.from("worker_credentials").insert({
      organisation_id: owner.orgId,
      worker_id: workerId,
      auth_user_id: login.data.user!.id,
      privacy_notice_accepted_at: new Date(now - 86_400_000).toISOString(),
      pin_set_at: new Date(now - 86_400_000).toISOString(),
      failed_attempts: 5,
      locked_until: new Date(now + 14 * 60_000).toISOString(),
      held_at: lock.held ? new Date(now - 60_000).toISOString() : null,
    });
    expect(cred.error).toBeNull();
    return workerId;
  }

  const lockedId = await workerWithLogin("Ibrahim", { held: false });
  const heldId = await workerWithLogin("Okafor", { held: true });
  // A colleague in the same company who doesn't report to this line manager.
  const strangerId = randomUUID();
  const stranger = await admin.from("workers").insert({
    id: strangerId,
    organisation_id: owner.orgId,
    staff_id: `UL-${suffix.slice(0, 4)}-S`,
    first_name: "Ada",
    last_name: `Stranger ${suffix}`,
    employment_type: "permanent",
    start_date: "2024-03-03",
  });
  expect(stranger.error).toBeNull();

  await signInViaUi(page, manager.email, manager.password);
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });

  // The held login: no unlock, only a new PIN.
  await page.goto(`/app/people/${heldId}`);
  const held = page.getByTestId("sign-in-status");
  await expect(held).toHaveAttribute("data-state", "held", { timeout: 15_000 });
  await expect(held).toContainText("Locked until a new PIN");
  await expect(held).toContainText("Ask HR to send them a new invite.");
  await expect(page.getByRole("button", { name: "Unlock sign-in" })).toHaveCount(0);
  // A line manager sees no pay or bank details.
  for (const section of ["Pay", "Bank details", "Tax and pension", "Next of kin"]) {
    await expect(page.getByRole("heading", { name: section, exact: true })).toHaveCount(0);
  }
  await expect(page.getByText("NIN", { exact: true })).toHaveCount(0);
  await expect(page.getByText("RSA PIN", { exact: true })).toHaveCount(0);

  // Someone who doesn't report to them is not found.
  await page.goto(`/app/people/${strangerId}`);
  await expect(page.getByText("This page could not be found.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(`Stranger ${suffix}`)).toHaveCount(0);

  // The locked login: unlock it.
  await page.goto(`/app/people/${lockedId}`);
  const status = page.getByTestId("sign-in-status");
  await expect(status).toHaveAttribute("data-state", "locked");
  await expectNoHorizontalScroll(page);
  await page.getByRole("button", { name: "Unlock sign-in" }).click();
  // The page refreshes with the login open again.
  await expect(status).toHaveAttribute("data-state", "open", { timeout: 15_000 });
  await page.reload();
  await expect(page.getByTestId("sign-in-status")).toHaveAttribute("data-state", "open");
  await expectNoHorizontalScroll(page);

  const { data: cred } = await admin
    .from("worker_credentials")
    .select("failed_attempts, locked_until")
    .eq("worker_id", lockedId)
    .single();
  expect(cred).toEqual({ failed_attempts: 0, locked_until: null });
  const { data: audit } = await admin
    .from("audit_log")
    .select("actor_id")
    .eq("entity_id", lockedId)
    .eq("action", "worker_auth.unlocked");
  expect(audit).toEqual([{ actor_id: manager.userId }]);
});
