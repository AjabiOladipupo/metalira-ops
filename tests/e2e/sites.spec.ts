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
 * Slice 2.2 acceptance (runs at 390px and 1440px through the Playwright projects): an
 * import-created, name-only site ("Needs details") gets its address and a 100 m geofence from
 * typed coordinates, three checkpoints print as QR codes, and a new code for one checkpoint
 * changes its QR. Map tiles are never fetched: MapTiler requests are refused, and CI has no key.
 */
test("ops_manager finishes an imported site: geofence, checkpoints, QR sheet", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const suffix = uniqueSuffix();
  const owner = await createOwner("sites-owner", `Kola Guarding ${suffix}`);
  const ops = await createAccount("sites-ops", "Obinna Okafor");
  const finance = await createAccount("sites-fin", "Femi Adeyemi");
  await addMembership(owner.orgId, ops.userId, "ops_manager");
  await addMembership(owner.orgId, finance.userId, "finance");

  // As the people import leaves it: a client and a site with names only.
  const admin = adminClient();
  const client = await admin
    .from("clients")
    .insert({ organisation_id: owner.orgId, name: "Coastline Logistics" })
    .select("id")
    .single();
  expect(client.error).toBeNull();
  const clientId = client.data!.id;
  const site = await admin
    .from("sites")
    .insert({ organisation_id: owner.orgId, client_id: clientId, name: "Apapa Warehouse 3" })
    .select("id")
    .single();
  expect(site.error).toBeNull();
  const siteId = site.data!.id;

  const context = await browser.newContext();
  await context.route(/api\.maptiler\.com/, (route) => route.abort());
  const page = await context.newPage();
  await signInViaUi(page, ops.email, ops.password);
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });

  await page.goto("/app/clients");
  await expect(page.getByText("(1 without a geofence)", { exact: false })).toBeVisible();

  await page.goto(`/app/clients/${clientId}?tab=sites`);
  const row = page.getByRole("link", { name: /Apapa Warehouse 3/ });
  await expect(row).toContainText("No geofence");
  await expect(row).toContainText("Needs details");
  await expectNoHorizontalScroll(page);
  await row.click();

  await expect(page).toHaveURL(new RegExp(`/sites/${siteId}$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Apapa Warehouse 3");
  await expect(page.getByTestId("site-needs-details")).toContainText("an address and a geofence");
  await expectNoHorizontalScroll(page);

  // Address.
  const details = page.getByRole("form", { name: "Site details" });
  await details.getByRole("textbox", { name: "Address" }).fill("Wharf Road, Apapa");
  await details.getByRole("combobox", { name: "State" }).selectOption("Lagos");
  await details.getByRole("button", { name: "Save details" }).click();
  await expect(details.getByText("Saved")).toBeVisible({ timeout: 15_000 });

  // Geofence by typed coordinates; the radius starts at 100 m.
  const fence = page.getByRole("form", { name: "Geofence" });
  await expect(fence.getByRole("textbox", { name: "Radius (metres)" })).toHaveValue("100");
  await fence.getByRole("textbox", { name: "Latitude" }).fill("51.5");
  await fence.getByRole("textbox", { name: "Longitude" }).fill("-0.12");
  await fence.getByRole("button", { name: "Save geofence" }).click();
  await expect(fence.getByText("The pin must be in Nigeria").first()).toBeVisible({
    timeout: 15_000,
  });
  await fence.getByRole("textbox", { name: "Latitude" }).fill("6.4474");
  await fence.getByRole("textbox", { name: "Longitude" }).fill("3.3611");
  await expect(fence.getByTestId("geofence-preview")).toHaveText("100 m circle · 3.1 ha");
  await fence.getByRole("button", { name: "Save geofence" }).click();
  await expect(fence.getByText("Geofence saved")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("site-needs-details")).toHaveCount(0);
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Three checkpoints.
  const add = page.getByRole("form", { name: "Add checkpoint" });
  for (const name of ["Gate A", "Warehouse floor", "Gate B"]) {
    await add.getByRole("textbox", { name: "Checkpoint name" }).fill(name);
    await add.getByRole("button", { name: "Add checkpoint" }).click();
    await expect(page.getByRole("form", { name: new RegExp(`: ${name}$`) })).toBeVisible({
      timeout: 15_000,
    });
  }
  await expect(page.getByTestId("checkpoint-row")).toHaveCount(3);
  await expectNoHorizontalScroll(page);

  // The print sheet: one QR code per checkpoint, in round order.
  await page.getByRole("link", { name: "Print QR sheet" }).click();
  await expect(page).toHaveURL(/\/checkpoints\/print$/);
  await expect(page.getByTestId("checkpoint-card")).toHaveCount(3);
  await expect(page.getByTestId("checkpoint-card").first()).toContainText("1. Gate A");
  await expect(page.getByRole("button", { name: "Print" })).toBeVisible();
  const firstQr = await page.getByTestId("checkpoint-qr").first().getAttribute("src");
  const lastQr = await page.getByTestId("checkpoint-qr").last().getAttribute("src");
  expect(firstQr).toMatch(/^data:image\/svg\+xml;base64,/);
  await expectNoHorizontalScroll(page);

  // A new code for Gate A changes its QR, and only its QR.
  await page.goto(`/app/clients/${clientId}/sites/${siteId}`);
  const gateA = page.getByRole("form", { name: "Checkpoint 1: Gate A" });
  await gateA.getByRole("button", { name: "New QR code" }).click();
  await expect(page.getByText("New code made.", { exact: false })).toBeVisible({
    timeout: 15_000,
  });
  await page.goto(`/app/clients/${clientId}/sites/${siteId}/checkpoints/print`);
  await expect(page.getByTestId("checkpoint-card")).toHaveCount(3);
  expect(await page.getByTestId("checkpoint-qr").first().getAttribute("src")).not.toBe(firstQr);
  expect(await page.getByTestId("checkpoint-qr").last().getAttribute("src")).toBe(lastQr);

  // Finance reads the site, without forms, and can't open the QR sheet.
  const financeContext = await browser.newContext();
  await financeContext.route(/api\.maptiler\.com/, (route) => route.abort());
  const financePage = await financeContext.newPage();
  await signInViaUi(financePage, finance.email, finance.password);
  await expect(financePage).toHaveURL(/\/app$/, { timeout: 15_000 });
  await financePage.goto(`/app/clients/${clientId}/sites/${siteId}`);
  await expect(financePage.getByRole("heading", { level: 1 })).toHaveText("Apapa Warehouse 3");
  await expect(financePage.getByRole("form", { name: "Geofence" })).toHaveCount(0);
  await expect(financePage.getByRole("link", { name: "Print QR sheet" })).toHaveCount(0);
  await financePage.goto(`/app/clients/${clientId}/sites/${siteId}/checkpoints/print`);
  await expect(financePage).toHaveURL(/\/no-access/);

  // Audited, by the ops manager, through the manager app; never the token.
  const { data: audit } = await admin
    .from("audit_log")
    .select("action, actor_id, channel")
    .eq("organisation_id", owner.orgId)
    .in("action", ["sites.update", "site_checkpoints.insert", "checkpoint.qr_rotated"]);
  const rows = audit ?? [];
  expect(rows.filter((r) => r.action === "site_checkpoints.insert")).toHaveLength(3);
  expect(rows.some((r) => r.action === "checkpoint.qr_rotated")).toBe(true);
  expect(rows.every((r) => r.actor_id === ops.userId && r.channel === "web")).toBe(true);
});

test("ops_manager adds a site from the client's Sites tab", async ({ browser }) => {
  test.setTimeout(120_000);
  const suffix = uniqueSuffix();
  const owner = await createOwner("sites-add", `Adebayo Facility ${suffix}`);
  const client = await adminClient()
    .from("clients")
    .insert({ organisation_id: owner.orgId, name: "Greenfield Estates" })
    .select("id")
    .single();
  const clientId = client.data!.id;

  const page = await (await browser.newContext()).newPage();
  await signInViaUi(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/app/, { timeout: 15_000 });
  await page.goto(`/app/clients/${clientId}?tab=sites`);
  await expect(page.getByText("No sites yet. Add the places your people work.")).toBeVisible();
  await page.getByRole("link", { name: "Add site" }).click();
  await expect(page).toHaveURL(/\/sites\/new$/);
  const form = page.getByRole("form", { name: "Add site" });
  await form.getByRole("textbox", { name: "Site name" }).fill("Lekki Estate Gate B");
  await form.getByRole("textbox", { name: "Landmark" }).fill("Beside the chapel");
  await expectNoHorizontalScroll(page);
  await form.getByRole("button", { name: "Add site" }).click();
  await expect(page).toHaveURL(/\/sites\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Lekki Estate Gate B");
  await expect(page.getByTestId("site-needs-details")).toBeVisible();
});
