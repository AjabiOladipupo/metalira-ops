/**
 * Slice 3.1 at phone width: an invited worker agrees to location from Me -> Location and selfie,
 * then withdraws it; an inbox item the server added shows a dot on the header, opens in the
 * inbox and is marked read.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient, anonClient } from "../rls/helpers/supabase";
import { NEEDS_SUPABASE, createOwner, supabaseReady, uniqueSuffix } from "./helpers/auth";

test.skip(!supabaseReady, NEEDS_SUPABASE);

const PIN = "482913";

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function setup() {
  const suffix = uniqueSuffix();
  const owner = await createOwner("consent", `Consent Co ${suffix}`);
  const admin = adminClient();
  const worker = await admin
    .from("workers")
    .insert({
      organisation_id: owner.orgId,
      employment_type: "permanent",
      start_date: "2024-03-03",
      staff_id: `CN-${suffix.slice(0, 4)}`,
      first_name: "Musa",
      last_name: "Ibrahim",
    })
    .select("id")
    .single();
  if (worker.error) throw new Error(worker.error.message);
  const ownerClient = anonClient();
  await ownerClient.auth.signInWithPassword({ email: owner.email, password: owner.password });
  const invite = await ownerClient.rpc("create_worker_invites", {
    p_organisation_id: owner.orgId,
    p_worker_ids: [worker.data.id],
    p_sent_via: "print",
  });
  if (invite.error) throw new Error(invite.error.message);
  return { orgId: owner.orgId, workerId: worker.data.id, token: invite.data![0]!.token };
}

test("a worker agrees to location, withdraws it from Me, and reads an inbox message", async ({
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-390", "The worker app is phone-first.");
  test.setTimeout(180_000);
  const s = await setup();

  const phone = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: { width: 390, height: 844 },
  });
  const w = await phone.newPage();
  await w.goto(`/m/invite/${s.token}`);
  await w.getByLabel("New PIN").fill(PIN);
  await w.getByLabel("Type the PIN again").fill(PIN);
  await w.getByRole("checkbox", { name: /I have read this/ }).check();
  await w.getByRole("button", { name: "Set PIN and sign in" }).click();
  await expect(w).toHaveURL(/\/m$/, { timeout: 15_000 });

  // No messages yet: no dot.
  await expect(w.getByRole("link", { name: "Inbox", exact: true })).toHaveAttribute(
    "data-unread",
    "0",
  );

  // Me -> Location and selfie.
  await w.getByRole("link", { name: "My profile" }).click();
  await w.getByTestId("me-consent-link").click();
  await expect(w).toHaveURL(/\/m\/me\/consent$/);
  await expect(w.getByRole("heading", { level: 1 })).toHaveText("Location and selfie");
  await expect(w.getByTestId("consent-decline")).toContainText("your supervisor clocks you in");
  const location = w.getByTestId("consent-location");
  await expect(location).toHaveAttribute("data-agreed", "no");
  await expect(location).toContainText("You have not agreed");
  await expectNoHorizontalScroll(w);

  await location.getByRole("button", { name: "I agree" }).click();
  await expect(location).toHaveAttribute("data-agreed", "yes", { timeout: 15_000 });
  await expect(location).toContainText("You agreed on");
  await expect(w.getByTestId("consent-selfie")).toHaveAttribute("data-agreed", "no");

  const admin = adminClient();
  const open = await admin
    .from("worker_consents")
    .select("kind, notice_version, withdrawn_at")
    .eq("worker_id", s.workerId);
  expect(open.data).toEqual([{ kind: "location", notice_version: "1.0", withdrawn_at: null }]);

  // Back on Me later, the worker withdraws.
  await w.goto("/m/me");
  await w.getByTestId("me-consent-link").click();
  await w.getByTestId("consent-location").getByRole("button", { name: "Withdraw" }).click();
  await expect(w.getByTestId("consent-location")).toHaveAttribute("data-agreed", "no", {
    timeout: 15_000,
  });
  await expect(w.getByTestId("consent-location")).toContainText("You withdrew on");
  const after = await admin
    .from("worker_consents")
    .select("withdrawn_at")
    .eq("worker_id", s.workerId);
  expect(after.data).toHaveLength(1);
  expect(after.data![0]!.withdrawn_at).not.toBeNull();

  // The server sends a message; the header shows a dot.
  const item = await admin
    .from("inbox_items")
    .insert({
      organisation_id: s.orgId,
      worker_id: s.workerId,
      kind: "general",
      title: "Roster published",
      body: "Your shifts for next week are ready.",
      link_path: "/m/shifts",
    })
    .select("id")
    .single();
  expect(item.error).toBeNull();
  await w.goto("/m");
  await expect(w.getByTestId("inbox-unread-dot")).toBeVisible();
  await w.getByRole("link", { name: "Inbox, 1 unread" }).click();
  await expect(w).toHaveURL(/\/m\/inbox$/);
  const message = w.getByTestId("inbox-item");
  await expect(message).toHaveAttribute("data-unread", "yes");
  await expect(message).toContainText("Your shifts for next week are ready.");
  await expect(message.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/m/shifts");
  await expectNoHorizontalScroll(w);

  await message.getByRole("button", { name: "Mark as read" }).click();
  await expect(message).toHaveAttribute("data-unread", "no", { timeout: 15_000 });
  await w.goto("/m");
  await expect(w.getByRole("link", { name: "Inbox", exact: true })).toHaveAttribute(
    "data-unread",
    "0",
  );
  const read = await admin.from("inbox_items").select("read_at").eq("id", item.data!.id).single();
  expect(read.data!.read_at).not.toBeNull();

  await phone.close();
});
