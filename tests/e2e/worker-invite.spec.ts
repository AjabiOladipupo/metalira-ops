/**
 * Slice 1.9: worker invites and PIN sign-in, end to end at phone width.
 * HR prints an invite sheet → the worker opens the link, sets a PIN → signs out → signs in with
 * company code, staff ID and PIN → five wrong PINs lock sign-in. The manager screen is checked
 * at both widths.
 */
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
  type TestOwner,
} from "./helpers/auth";

test.skip(!supabaseReady, NEEDS_SUPABASE);

const PIN = "482913";
const INVALID = "Those details don't match. Check the company code, staff ID and PIN.";
const LOCKED = /Too many wrong tries\. Sign-in is locked for 15 minutes/;

/** The form's own message (Next adds an empty route announcer with role alert too). */
const formAlert = (page: Page) => page.locator('p[role="alert"]');

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

interface Setup {
  owner: TestOwner;
  companyCode: string;
  worker: { id: string; staffId: string; firstName: string; lastName: string };
}

/** An owner with one worker on a site (no email, so the invite is printed). */
async function setup(label: string): Promise<Setup> {
  const suffix = uniqueSuffix();
  const owner = await createOwner(label, `Invite Test Co ${suffix}`);
  const admin = adminClient();
  const client = await admin
    .from("clients")
    .insert({ organisation_id: owner.orgId, name: "Coastline Logistics" })
    .select("id")
    .single();
  const site = await admin
    .from("sites")
    .insert({ organisation_id: owner.orgId, client_id: client.data!.id, name: "Apapa Warehouse 3" })
    .select("id")
    .single();
  const staffId = `MO-${suffix.slice(0, 4).toUpperCase()}`;
  const worker = await admin
    .from("workers")
    .insert({
      organisation_id: owner.orgId,
      staff_id: staffId,
      first_name: "Musa",
      last_name: "Ibrahim",
      employment_type: "permanent",
      start_date: "2025-01-06",
    })
    .select("id")
    .single();
  if (worker.error) throw new Error(worker.error.message);
  await admin.from("worker_assignments").insert({
    organisation_id: owner.orgId,
    worker_id: worker.data!.id,
    site_id: site.data!.id,
    effective_from: "2025-01-06",
  });
  const org = await admin
    .from("organisations")
    .select("company_code")
    .eq("id", owner.orgId)
    .single();
  return {
    owner,
    companyCode: org.data!.company_code,
    worker: { id: worker.data!.id, staffId, firstName: "Musa", lastName: "Ibrahim" },
  };
}

/** Signs the owner in, prints a sheet for the worker and returns the invite link's path. */
async function printInvite(page: Page, s: Setup): Promise<string> {
  await signInViaUi(page, s.owner.email, s.owner.password);
  await expect(page).toHaveURL(/\/app$/);
  await page.goto("/app/people/invites");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Worker invites");
  await expect(
    page.getByText("1 employee · 0 signed up · 0 invited · 1 not invited"),
  ).toBeVisible();
  await expect(page.getByText(s.companyCode, { exact: true }).first()).toBeVisible();

  const row = page.getByRole("row", { name: /Musa Ibrahim/ });
  await expect(row.getByText("Not invited")).toBeVisible();
  await expect(row.getByText("Apapa Warehouse 3")).toBeVisible();
  await row.getByRole("checkbox", { name: "Choose Musa Ibrahim" }).check();
  await expect(page.getByRole("button", { name: /^Email invites/ })).toBeDisabled();
  await page.getByRole("button", { name: "Print invite sheet (1)" }).click();

  const card = page.getByTestId("invite-card");
  await expect(card).toHaveCount(1, { timeout: 15_000 });
  await expect(card).toContainText("Musa Ibrahim");
  await expect(card).toContainText(`Staff ID ${s.worker.staffId}`);
  await expect(card).toContainText(`Company code ${s.companyCode}`);
  await expect(card.getByRole("img", { name: /QR code/ })).toBeVisible();
  await expectNoHorizontalScroll(page);
  const url = await card.getByTestId("invite-url").innerText();
  expect(url).toMatch(/\/m\/invite\/[0-9a-f]{64}$/);
  return new URL(url).pathname;
}

/**
 * Fills and submits the worker sign-in form. It first waits for any earlier try to finish
 * rendering (the button leaves its pending state), so it never types into a form that React is
 * about to reset, then waits for the server's answer.
 */
async function signInAsWorker(page: Page, companyCode: string, staffId: string, pin: string) {
  const submit = page.getByRole("button", { name: /^(Sign in|Signing in…)$/ });
  await expect(submit).toHaveText("Sign in");
  await expect(submit).toBeEnabled();
  await page.getByLabel("Company code").fill(companyCode);
  await page.getByLabel("Staff ID").fill(staffId);
  await page.getByLabel("PIN").fill(pin);
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/m/")),
    submit.click(),
  ]);
}

test("invite link → set PIN → sign out → sign in with company code, staff ID and PIN → five wrong PINs lock", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-390", "The worker flow is phone-first.");
  test.setTimeout(120_000);
  const s = await setup("invite");
  const invitePath = await printInvite(page, s);

  // The worker's own phone: a fresh browser at 390px.
  const phone = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: { width: 390, height: 844 },
  });
  const w = await phone.newPage();

  await w.goto(invitePath);
  await expect(w.getByRole("heading", { level: 1 })).toHaveText("Set your PIN");
  await expect(w.getByTestId("invite-identity")).toHaveText(
    `Is this you? Musa Ibrahim · staff ID ${s.worker.staffId}`,
  );
  await expect(w.getByTestId("invite-keep")).toContainText(`company code ${s.companyCode}`);
  await expectNoHorizontalScroll(w);

  // The rules are checked before anything is saved.
  await w.getByLabel("New PIN").fill("123456");
  await w.getByLabel("Type the PIN again").fill("123456");
  await w.getByRole("button", { name: "Set PIN and sign in" }).click();
  await expect(w.getByText(/Choose a PIN that is harder to guess/)).toBeVisible();
  await expect(w.getByText("Tick the box to continue.")).toBeVisible();

  await w.getByLabel("New PIN").fill(PIN);
  await w.getByLabel("Type the PIN again").fill(PIN);
  await w.getByRole("checkbox", { name: /I have read this/ }).check();
  await w.getByRole("button", { name: "Set PIN and sign in" }).click();
  await expect(w).toHaveURL(/\/m$/, { timeout: 15_000 });
  await expect(w.getByRole("heading", { level: 1 })).toHaveText("Hello, Musa");
  await expectNoHorizontalScroll(w);

  // A worker session never reaches the manager app.
  await w.goto("/app/people");
  await expect(w).toHaveURL(/\/m$/);

  // The link worked once.
  await w.goto(invitePath);
  await expect(formAlert(w)).toContainText("This invite has already been used");

  // Sign out (on Me), then sign in with company code, staff ID and PIN (any case).
  await w.goto("/m/me");
  await w.getByRole("button", { name: "Sign out" }).click();
  await expect(w).toHaveURL(/\/m\/sign-in$/);
  await signInAsWorker(w, s.companyCode.toLowerCase(), s.worker.staffId.toLowerCase(), PIN);
  await expect(w).toHaveURL(/\/m$/, { timeout: 15_000 });
  await expect(w.getByRole("heading", { level: 1 })).toHaveText("Hello, Musa");

  await w.goto("/m/me");
  await w.getByRole("button", { name: "Sign out" }).click();
  await expect(w).toHaveURL(/\/m\/sign-in$/);

  // An unknown staff ID gets the same answer as a wrong PIN.
  await signInAsWorker(w, s.companyCode, "NOBODY-1", PIN);
  await expect(formAlert(w)).toHaveText(INVALID);

  // Four wrong PINs: the same answer. The fifth locks, and then even the right PIN is refused.
  for (let i = 1; i <= 4; i += 1) {
    await signInAsWorker(w, s.companyCode, s.worker.staffId, "000111");
    await expect(formAlert(w)).toHaveText(INVALID);
  }
  await signInAsWorker(w, s.companyCode, s.worker.staffId, "000111");
  await expect(formAlert(w)).toHaveText(LOCKED);
  await signInAsWorker(w, s.companyCode, s.worker.staffId, PIN);
  await expect(w.getByRole("button", { name: "Sign in" })).toBeEnabled();
  await expect(formAlert(w)).toHaveText(LOCKED);
  await expect(w).toHaveURL(/\/m\/sign-in$/);
  await phone.close();

  // HR sees the lock; the database audited it.
  await page.reload();
  await expect(
    page.getByRole("row", { name: /Musa Ibrahim/ }).getByText(/Locked until/),
  ).toBeVisible();
  const audit = await adminClient()
    .from("audit_log")
    .select("action")
    .eq("entity_id", s.worker.id)
    .eq("action", "worker_auth.locked");
  expect(audit.data).toHaveLength(1);
});

test("the invites screen fits the width, and only owner, admin and HR may open it", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const s = await setup("invites-screen");
  await printInvite(page, s);
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("invite-card")).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("row", { name: /Musa Ibrahim/ }).getByText("Invite printed"),
  ).toBeVisible();
  await expectNoHorizontalScroll(page);

  // An operations manager sees People but not invites.
  const ops = await createAccount("invites-ops", "Ops Manager");
  await addMembership(s.owner.orgId, ops.userId, "ops_manager");
  await page.context().clearCookies();
  await signInViaUi(page, ops.email, ops.password);
  await expect(page).toHaveURL(/\/app$/);
  await page.goto("/app/people/invites");
  await expect(page).toHaveURL(/\/no-access$/);
});
