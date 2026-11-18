/**
 * Slice 1.10: the worker app shell and profile, at phone width. An invited worker signs in,
 * sees home (no shift yet, shortcut tiles, bottom nav, no language picker), opens Me and sees
 * their own profile with masked values, raises a bank change that appears in HR's approvals,
 * sends a change request HR deals with on the worker page, and can't reach anyone else's data.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient, anonClient } from "../rls/helpers/supabase";
import {
  NEEDS_SUPABASE,
  createOwner,
  signInViaUi,
  supabaseReady,
  uniqueSuffix,
  type TestOwner,
} from "./helpers/auth";

test.skip(!supabaseReady, NEEDS_SUPABASE);

const PIN = "482913";

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

interface Setup {
  owner: TestOwner;
  workerId: string;
  colleagueId: string;
  token: string;
}

/** An owner, a mapped worker with pay and identity details on file, and a colleague. */
async function setup(): Promise<Setup> {
  const suffix = uniqueSuffix();
  const owner = await createOwner("worker-app", `Worker App Co ${suffix}`);
  const admin = adminClient();
  const org = owner.orgId;
  const client = await admin
    .from("clients")
    .insert({ organisation_id: org, name: "Coastline Logistics" })
    .select("id")
    .single();
  const site = await admin
    .from("sites")
    .insert({ organisation_id: org, client_id: client.data!.id, name: "Apapa Warehouse 3" })
    .select("id")
    .single();
  const project = await admin
    .from("projects")
    .insert({ organisation_id: org, client_id: client.data!.id, name: "Coastline guarding" })
    .select("id")
    .single();
  const dept = await admin
    .from("departments")
    .insert({ organisation_id: org, name: "Security services" })
    .select("id")
    .single();
  const base = {
    organisation_id: org,
    employment_type: "permanent",
    start_date: "2024-03-03",
  } as const;
  const manager = await admin
    .from("workers")
    .insert({
      ...base,
      staff_id: `KA-${suffix.slice(0, 4)}`,
      first_name: "Kola",
      last_name: "Adebayo",
    })
    .select("id")
    .single();
  // Written with the secret key, as after an applied bank change and an import.
  const worker = await admin
    .from("workers")
    .insert({
      ...base,
      staff_id: `MO-${suffix.slice(0, 4)}`,
      first_name: "Musa",
      last_name: "Ibrahim",
      job_title: "Security guard",
      phone: "08031234410",
      department_id: dept.data!.id,
      line_manager_worker_id: manager.data!.id,
      bank_name: "GTBank",
      account_name: "Musa Ibrahim",
      bank_account_enc: "\\x00112233445566778899",
      bank_account_last4: "7712",
      nin_enc: "\\x00112233445566778899",
      pfa_name: "Stanbic IBTC",
      rsa_pin_enc: "\\x00112233445566778899",
      rsa_pin_last4: "4421",
      tax_state: "Lagos",
      annual_rent_declared_kobo: 36_000_000,
      next_of_kin_name: "Aisha Ibrahim",
    })
    .select("id")
    .single();
  if (worker.error) throw new Error(worker.error.message);
  const colleague = await admin
    .from("workers")
    .insert({ ...base, staff_id: `AO-${suffix.slice(0, 4)}`, first_name: "Ada", last_name: "Obi" })
    .select("id")
    .single();
  await admin.from("worker_assignments").insert({
    organisation_id: org,
    worker_id: worker.data!.id,
    site_id: site.data!.id,
    project_id: project.data!.id,
    effective_from: "2024-03-03",
  });

  // The owner prints an invite (as on the invites screen) and hands the link over.
  const ownerClient = anonClient();
  await ownerClient.auth.signInWithPassword({ email: owner.email, password: owner.password });
  const invite = await ownerClient.rpc("create_worker_invites", {
    p_organisation_id: org,
    p_worker_ids: [worker.data!.id],
    p_sent_via: "print",
  });
  if (invite.error) throw new Error(invite.error.message);
  return {
    owner,
    workerId: worker.data!.id,
    colleagueId: colleague.data!.id,
    token: invite.data![0]!.token,
  };
}

test("a signed-in worker sees their own masked profile, raises a bank change HR sees, and reaches no one else's data", async ({
  page,
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

  // Set a PIN from the invite; the worker lands on home.
  await w.goto(`/m/invite/${s.token}`);
  await w.getByLabel("New PIN").fill(PIN);
  await w.getByLabel("Type the PIN again").fill(PIN);
  await w.getByRole("checkbox", { name: /I have read this/ }).check();
  await w.getByRole("button", { name: "Set PIN and sign in" }).click();
  await expect(w).toHaveURL(/\/m$/, { timeout: 15_000 });

  // Home, per the WkHome board.
  await expect(w.getByRole("heading", { level: 1 })).toHaveText("Hello, Musa");
  await expect(w.getByText("No shift today")).toBeVisible();
  const shortcuts = w.getByRole("navigation", { name: "Shortcuts" });
  for (const tile of ["My shifts", "Leave", "Payslips", "Help"]) {
    await expect(shortcuts.getByRole("link", { name: tile })).toBeVisible();
  }
  await expect(w.getByText("Your location is used only while you are clocked in.")).toBeVisible();
  const nav = w.getByRole("navigation", { name: "Worker menu" });
  await expect(nav.getByRole("link")).toHaveText(["Home", "Clock", "Leave", "Payslips", "Me"]);
  await expect(nav.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
  await expect(w.getByLabel("Language")).toHaveCount(0);
  // Home has the theme switcher and no back arrow.
  await expect(w.getByRole("button", { name: /^Theme: / })).toBeVisible();
  await expect(w.getByTestId("back-link")).toHaveCount(0);
  await expectNoHorizontalScroll(w);

  // It can be added to the home screen.
  await expect(w.locator('link[rel="manifest"]')).toHaveAttribute("href", "/worker.webmanifest");
  const manifest = await w.request.get("/worker.webmanifest");
  expect(manifest.ok()).toBe(true);
  expect(((await manifest.json()) as { start_url: string }).start_url).toBe("/m");

  // A later-phase tab says what is coming, inside the app.
  await nav.getByRole("link", { name: "Payslips" }).click();
  await expect(w.getByRole("heading", { level: 1 })).toHaveText("Payslips");
  await expect(w.getByRole("button", { name: /^Theme: / })).toBeVisible();
  // Its back arrow sits where Me has it (Wk* boards), so the top row does not jump between tabs.
  const soonBack = await w.getByTestId("back-link").boundingBox();
  await w.getByRole("link", { name: "Back to home" }).click();
  await expect(w).toHaveURL(/\/m$/);

  // Me, per the WkProfile board: the worker's own details, masked.
  await w.goto("/m");
  await w.getByRole("link", { name: "My profile" }).click();
  await expect(w).toHaveURL(/\/m\/me$/);
  await expect(w.getByText("Musa Ibrahim", { exact: true })).toBeVisible();
  expect((await w.getByTestId("back-link").boundingBox())?.y).toBe(soonBack?.y);
  await expect(w.getByText(/Security guard · MO-/)).toBeVisible();
  await expect(w.getByTestId("me-department")).toHaveText("Security services");
  await expect(w.getByTestId("me-line-manager")).toHaveText("Kola Adebayo");
  await expect(w.getByTestId("me-site")).toHaveText("Apapa Warehouse 3");
  await expect(w.getByTestId("me-project")).toHaveText("Coastline guarding");
  await expect(w.getByTestId("me-started")).toHaveText("3 Mar 2024 · permanent");
  await expect(w.getByTestId("me-bank")).toHaveText("GTBank ••••7712");
  await expect(w.getByTestId("me-pension")).toHaveText("Stanbic IBTC · PEN••••4421");
  await expect(w.getByTestId("me-tax-state")).toHaveText("Lagos");
  await expect(w.getByTestId("me-rent")).toHaveText("₦360,000 a year");
  await expect(w.getByTestId("me-nin")).toHaveText("On file");
  await expect(w.getByTestId("me-phone")).toHaveText("0803 ••• 4410");
  await expect(w.getByTestId("me-next-of-kin")).toHaveText("Aisha Ibrahim");
  expect(await w.content()).not.toContain("08031234410");
  const profileTab = w.getByRole("tab", { name: "Profile" });
  const queriesTab = w.getByRole("tab", { name: "Queries" });
  await expect(profileTab).toHaveAttribute("aria-selected", "true");
  // Queries opens on tap (it used to be a disabled button phones could not tap) with an empty
  // state, and the arrow keys move back to Profile.
  await queriesTab.click();
  await expect(queriesTab).toHaveAttribute("aria-selected", "true");
  await expect(w.getByTestId("me-queries-empty")).toHaveText(
    "No queries. When your line manager sends you a query, it shows here.",
  );
  await expect(w.getByTestId("me-bank")).toBeHidden();
  await queriesTab.press("ArrowLeft");
  await expect(profileTab).toHaveAttribute("aria-selected", "true");
  await expect(profileTab).toBeFocused();
  await expect(w.getByTestId("me-queries-empty")).toBeHidden();
  await expect(w.getByTestId("me-bank")).toBeVisible();
  await expect(
    w.getByText(
      "Bank changes need HR approval and wait 72 hours before your pay goes to the new account.",
    ),
  ).toBeVisible();
  await expectNoHorizontalScroll(w);

  // Request a change: new bank details.
  await expect(w.getByRole("link", { name: "Back to home" })).toHaveAttribute("href", "/m");
  await w.getByRole("link", { name: "Request a change" }).click();
  await expect(w.getByRole("heading", { level: 1 })).toHaveText("Request a change");
  await expect(w.getByRole("link", { name: "Back to Me" })).toHaveAttribute("href", "/m/me");
  await w.getByRole("radio", { name: "Bank details" }).check();
  const bank = w.getByRole("form", { name: "Bank details" });
  await bank.getByLabel("Bank name").fill("Access Bank");
  await bank.getByLabel("Account name").fill("Musa Ibrahim");
  await bank.getByLabel("Account number").fill("012345");
  await bank.getByRole("button", { name: "Send for approval" }).click();
  await expect(w.getByText("Bank account numbers are 10 digits.")).toBeVisible();
  await w.getByLabel("Account number").fill("0123 459 981");
  await w.getByRole("button", { name: "Send for approval" }).click();
  await expect(w.getByRole("status")).toContainText("Sent for approval.");
  await expectNoHorizontalScroll(w);
  await w.getByRole("link", { name: "Back to my profile" }).click();
  const myBank = w.getByTestId("my-bank-change");
  await expect(myBank).toContainText("Bank change to Access Bank ••••9981");
  await expect(myBank).toContainText("Waiting for approval");
  // The bank details on file stay as they were until HR approves and the hold ends.
  await expect(w.getByTestId("me-bank")).toHaveText("GTBank ••••7712");

  // Request a change: something else, in the worker's own words, never with long numbers.
  await w.getByRole("link", { name: "Request a change" }).click();
  await expect(w.getByRole("radio", { name: /Bank details/ })).toBeDisabled();
  await w.getByRole("radio", { name: "Next of kin" }).check();
  // A two-line choice keeps its full-size radio.
  const workRadio = await w.getByRole("radio", { name: /Work details/ }).boundingBox();
  expect(workRadio?.width).toBeGreaterThanOrEqual(19);
  const details = w.getByLabel("What should change?");
  await details.fill("My next of kin is now my brother Sani, 0803 555 1234");
  await w.getByRole("button", { name: "Send to HR" }).click();
  await expect(w.getByText(/Leave out long numbers/)).toBeVisible();
  await w.getByLabel("What should change?").fill("My next of kin is now my brother Sani Ibrahim");
  await w.getByRole("button", { name: "Send to HR" }).click();
  await expect(w.getByRole("status")).toContainText("Sent to HR.");
  await w.getByRole("link", { name: "Back to my profile" }).click();
  await expect(w.getByTestId("my-change-request")).toContainText("Waiting for HR");

  // Nobody else's data: the manager app and another worker's page stay out of reach.
  await w.goto(`/app/people/${s.colleagueId}`);
  await expect(w).toHaveURL(/\/m$/);

  // HR (the owner) sees the bank change waiting for approval, raised by the employee.
  await signInViaUi(page, s.owner.email, s.owner.password);
  await expect(page).toHaveURL(/\/app$/);
  await page.goto("/app/people/approvals");
  const card = page.getByRole("article", { name: "Bank change for Musa Ibrahim" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Waiting for your approval");
  await expect(card).toContainText("••••9981");

  // And the change request on the worker page; marking it done shows on the worker's phone.
  await page.goto(`/app/people/${s.workerId}`);
  const request = page.getByRole("article", { name: "Next of kin change request" });
  await expect(request).toContainText("My next of kin is now my brother Sani Ibrahim");
  await request.getByLabel("Note to the employee").fill("Updated, thank you");
  await request.getByRole("button", { name: "Mark done" }).click();
  // The page refreshes: the request is closed, with the note kept.
  await expect(request).toContainText(/Done on /, { timeout: 15_000 });
  await expect(request).toContainText("Note: Updated, thank you");
  await expect(request.getByRole("button", { name: "Mark done" })).toHaveCount(0);

  await w.goto("/m/me");
  const mine = w.getByTestId("my-change-request");
  await expect(mine).toContainText("Done");
  await expect(mine).toContainText("HR: Updated, thank you");
  await phone.close();
});

test("worker app pages need a worker session", async ({ page }) => {
  for (const path of ["/m/me", "/m/me/change", "/m/clock", "/m/leave", "/m/payslips"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/m\/sign-in$/);
  }
});
