import { expect, test, type Page } from "@playwright/test";

import {
  NEEDS_SUPABASE,
  addMembership,
  createAccount,
  createOwner,
  followEmailLink,
  latestEmailTo,
  newPassword,
  signInViaUi,
  supabaseReady,
  uniqueEmail,
  uniqueSuffix,
} from "./helpers/auth";

test.skip(!supabaseReady, NEEDS_SUPABASE);

const switcher = (page: Page) => page.getByTestId("org-switcher");

async function signOutViaMenu(page: Page) {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
}

/** Sidebar on desktop, the menu sheet on mobile. Returns the nav's link names. */
async function navLinkNames(page: Page, isMobile: boolean): Promise<string[]> {
  if (isMobile) await page.getByRole("button", { name: "Open menu" }).click();
  const nav = isMobile
    ? page.getByRole("dialog", { name: "Menu" }).getByRole("navigation", { name: "Main" })
    : page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link").first()).toBeVisible();
  return nav.getByRole("link").allInnerTexts();
}

test("a new owner signs up, signs out, signs back in and sees only their own company", async ({
  page,
  browser,
  baseURL,
}) => {
  const alphaName = `Alpha Guards ${uniqueSuffix()}`;
  const email = uniqueEmail("alpha");
  const password = newPassword();

  // 1. The app is closed to signed-out visitors.
  await page.goto("/app/people");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp%2Fpeople$/);

  // 2. Sign up: name, company and email only (slice 1.13). The emailed link signs them in, and
  // they choose their password before the app opens.
  await page.getByRole("link", { name: "Create an account" }).click();
  await page.getByRole("textbox", { name: "Your full name" }).fill("Ada Okafor");
  await page.getByRole("textbox", { name: "Company name" }).fill(alphaName);
  await page.getByRole("textbox", { name: "Work email" }).fill(email);
  await expect(page.getByRole("textbox", { name: "Password" })).toHaveCount(0);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/check-email\?sent=signup$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Check your email");
  await followEmailLink(page, await latestEmailTo(email));
  await expect(page).toHaveURL(/\/set-password\?next=/, { timeout: 15_000 });
  await page.getByLabel("Choose a password").fill(password);
  await page.getByRole("button", { name: "Save password" }).click();
  // A new owner has not set up the company yet, so the app opens the setup wizard.
  await expect(page).toHaveURL(/\/app\/setup\/plan$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your plan");
  await expect(switcher(page)).toHaveText(alphaName);

  // 3. Sign out; the app is closed again.
  await signOutViaMenu(page);
  await page.goto("/app");
  await expect(page).toHaveURL(/\/sign-in$/);

  // 4. Sign back in with the password.
  await signInViaUi(page, email, password);
  await expect(page).toHaveURL(/\/app\/setup\/plan$/);
  await expect(switcher(page)).toHaveText(alphaName);

  // 5. Another owner, in another browser, sees only their own company, and Alpha never sees it.
  const betaName = `Beta Clean ${uniqueSuffix()}`;
  const beta = await createOwner("beta", betaName);
  const other = await browser.newContext({ baseURL });
  const betaPage = await other.newPage();
  await signInViaUi(betaPage, beta.email, beta.password);
  await expect(betaPage).toHaveURL(/\/app$/);
  await expect(switcher(betaPage)).toHaveText(betaName);
  await expect(betaPage.getByText(alphaName)).toHaveCount(0);
  await other.close();

  await page.reload();
  await expect(switcher(page)).toHaveText(alphaName);
  await expect(page.getByText(betaName)).toHaveCount(0);
});

test("a wrong password gets one generic message", async ({ page }) => {
  const owner = await createOwner("wrongpw", `Wrong Password Co ${uniqueSuffix()}`);
  await signInViaUi(page, owner.email, "not-the-password-1");
  await expect(page.getByText("That email and password don't match an account.")).toBeVisible();
  await signInViaUi(page, uniqueEmail("nobody"), "not-the-password-1");
  await expect(page.getByText("That email and password don't match an account.")).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("sign-in returns to the page the user asked for", async ({ page }) => {
  const owner = await createOwner("next", `Next Path Co ${uniqueSuffix()}`);
  await page.goto("/app/collections");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp%2Fcollections$/);
  await page.getByRole("textbox", { name: "Work email" }).fill(owner.email);
  await page.getByRole("textbox", { name: "Password" }).fill(owner.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/collections$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Collections");
});

test("an emailed sign-in link signs the owner in", async ({ page }) => {
  const owner = await createOwner("magic", `Magic Link Co ${uniqueSuffix()}`);
  await page.goto("/sign-in");
  await page.getByRole("tab", { name: "Email link" }).click();
  await page.getByRole("textbox", { name: "Work email" }).fill(owner.email);
  await page.getByRole("button", { name: "Send link" }).click();
  await expect(page).toHaveURL(/\/check-email\?sent=link$/);
  await followEmailLink(page, await latestEmailTo(owner.email));
  await expect(page).toHaveURL(/\/app$/);
  await expect(switcher(page)).toHaveText(owner.orgName);
});

test("an emailed sign-in link returns to the page the user asked for", async ({ page }) => {
  const owner = await createOwner("magic-next", `Magic Next Co ${uniqueSuffix()}`);
  await page.goto("/app/collections");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp%2Fcollections$/);
  await page.getByRole("tab", { name: "Email link" }).click();
  await page.getByRole("textbox", { name: "Work email" }).fill(owner.email);
  await page.getByRole("button", { name: "Send link" }).click();
  await expect(page).toHaveURL(/\/check-email\?sent=link$/);
  await followEmailLink(page, await latestEmailTo(owner.email));
  await expect(page).toHaveURL(/\/app\/collections$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Collections");
});

test("asking for a link for an unknown email looks the same as a known one", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByRole("tab", { name: "Email link" }).click();
  await page.getByRole("textbox", { name: "Work email" }).fill(uniqueEmail("unknown"));
  await page.getByRole("button", { name: "Send link" }).click();
  await expect(page).toHaveURL(/\/check-email\?sent=link$/);
});

test("a line manager sees five nav items and cannot open payroll by URL", async ({
  page,
  isMobile,
}, testInfo) => {
  const owner = await createOwner("lm-owner", `Line Manager Co ${uniqueSuffix()}`);
  const manager = await createAccount("lm");
  await addMembership(owner.orgId, manager.userId, "line_manager");

  await signInViaUi(page, manager.email, manager.password);
  await expect(page).toHaveURL(/\/app$/);
  const mobile = isMobile || testInfo.project.name === "mobile-390";
  expect(await navLinkNames(page, mobile)).toEqual([
    "Home",
    "Live attendance",
    "Timesheets",
    "My team",
    "Leave",
  ]);

  await page.goto("/app/payroll");
  await expect(page).toHaveURL(/\/no-access$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("You can't open this page");
  await page.getByRole("link", { name: "Back to home" }).click();
  await expect(page).toHaveURL(/\/app$/);
});

test("client approvers get the no-access page and workers the worker app", async ({ page }) => {
  const owner = await createOwner("roles-owner", `Roles Co ${uniqueSuffix()}`);
  const approver = await createAccount("approver");
  await addMembership(owner.orgId, approver.userId, "client_approver");
  const worker = await createAccount("worker");
  await addMembership(owner.orgId, worker.userId, "worker");

  await signInViaUi(page, approver.email, approver.password);
  await expect(page).toHaveURL(/\/no-access$/);
  await expect(page.getByText(/Client approver/)).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);

  // A worker membership added by hand, with no staff record linked: the worker app explains.
  await signInViaUi(page, worker.email, worker.password);
  await expect(page).toHaveURL(/\/m$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Almost there");
});

test("a manager in two companies switches between them, and the choice sticks", async ({
  page,
}) => {
  const first = await createOwner("multi", `Kilo Facility ${uniqueSuffix()}`);
  const second = await createOwner("multi-other", `Echo Staffing ${uniqueSuffix()}`);
  await addMembership(second.orgId, first.userId, "finance");
  const outsider = await createOwner("outsider", `Outsider Ltd ${uniqueSuffix()}`);

  await signInViaUi(page, first.email, first.password);
  await expect(page).toHaveURL(/\/app$/);
  // Defaults to the first company by name: Echo before Kilo.
  await expect(switcher(page)).toContainText(second.orgName);

  await switcher(page).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitemradio")).toHaveCount(2);
  await expect(menu.getByText(outsider.orgName)).toHaveCount(0);
  await menu.getByRole("menuitemradio", { name: new RegExp(first.orgName) }).click();
  await expect(switcher(page)).toContainText(first.orgName);

  await page.reload();
  await expect(switcher(page)).toContainText(first.orgName);
});
