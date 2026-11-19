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
 * Slice 2.1 acceptance (runs at 390px and 1440px through the Playwright projects): ops_manager
 * adds a client with a billing contact, adds a second contact, and sees "Needs details" go once
 * the billing address is in; finance reads the client but can't edit it; every save is audited.
 */
test("ops_manager adds a client with two contacts; finance reads it", async ({ browser }) => {
  test.setTimeout(150_000);
  const suffix = uniqueSuffix();
  const owner = await createOwner("clients-owner", `Kola Guarding ${suffix}`);
  const ops = await createAccount("clients-ops", "Obinna Okafor");
  const finance = await createAccount("clients-fin", "Femi Adeyemi");
  await addMembership(owner.orgId, ops.userId, "ops_manager");
  await addMembership(owner.orgId, finance.userId, "finance");

  const page = await (await browser.newContext()).newPage();
  await signInViaUi(page, ops.email, ops.password);
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });

  // The empty list, with its illustration and one action.
  await page.goto("/app/clients");
  await expect(page.getByText("No clients yet. Add the first company you work for.")).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.getByRole("link", { name: "Add client" }).click();

  await expect(page).toHaveURL(/\/app\/clients\/new$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add client");
  await page.getByRole("textbox", { name: "Client name" }).fill("Coastline Logistics");
  await page.getByRole("textbox", { name: "Tax ID (TIN)" }).fill("bad");
  await page.getByRole("textbox", { name: "Contact name" }).fill("Ngozi Eze");
  await page.getByRole("textbox", { name: "Contact email" }).fill("Accounts@Coastline.example");
  await expectNoHorizontalScroll(page);
  await page.getByRole("button", { name: "Add client" }).click();
  await expect(
    page.getByText("Enter the TIN as 12345678-0001, or as 10 to 13 digits"),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Tax ID (TIN)" }).fill("12345678-0001");
  await page.getByRole("button", { name: "Add client" }).click();

  await expect(page).toHaveURL(/\/app\/clients\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  const clientId = page.url().split("/").pop()!;
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Coastline Logistics");
  await expect(page.getByTestId("primary-billing")).toHaveText(
    "Ngozi Eze · accounts@coastline.example",
  );
  // No billing address yet.
  await expect(page.getByTestId("needs-details")).toContainText("a billing address");
  await expectNoHorizontalScroll(page);

  // A second contact: the first operations contact becomes its primary.
  await page.getByRole("link", { name: "Contacts", exact: true }).click();
  await expect(page).toHaveURL(/tab=contacts$/);
  const add = page.getByRole("form", { name: "Add contact" });
  await add.getByRole("textbox", { name: "Name" }).fill("Chika Obi");
  await add.getByRole("textbox", { name: "Email" }).fill("chika@coastline.example");
  await add.getByRole("textbox", { name: "Phone" }).fill("0803 123 4567");
  await add.getByRole("combobox", { name: "Role" }).selectOption("ops");
  await add.getByRole("button", { name: "Add contact" }).click();
  await expect(add.getByText("Contact added")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("form", { name: "Contact Chika Obi" })).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Finish the details: the address clears "Needs details".
  await page.goto(`/app/clients/${clientId}/edit`);
  await page.getByRole("textbox", { name: "Billing address" }).fill("4 Wharf Road\nApapa");
  await page.getByRole("combobox", { name: "State" }).selectOption("Lagos");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/clients/${clientId}$`), { timeout: 15_000 });
  await expect(page.getByTestId("needs-details")).toHaveCount(0);

  await page.goto("/app/clients");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "1 client · all with billing details",
  );
  await expect(page.getByRole("link", { name: /Coastline Logistics/ })).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Finance reads the client and its contacts, with no edit controls.
  const financePage = await (await browser.newContext()).newPage();
  await signInViaUi(financePage, finance.email, finance.password);
  await expect(financePage).toHaveURL(/\/app$/, { timeout: 15_000 });
  await financePage.goto(`/app/clients/${clientId}`);
  await expect(financePage.getByRole("heading", { level: 1 })).toHaveText("Coastline Logistics");
  await expect(financePage.getByRole("link", { name: "Edit details" })).toHaveCount(0);
  await expect(financePage.getByRole("button", { name: "Archive client" })).toHaveCount(0);
  await financePage.goto(`/app/clients/${clientId}/edit`);
  await expect(financePage).toHaveURL(/\/no-access/);

  // Every save audited, by the ops manager, through the manager app.
  const { data: audit } = await adminClient()
    .from("audit_log")
    .select("action, actor_id, channel")
    .eq("organisation_id", owner.orgId)
    .in("action", ["clients.insert", "clients.update", "client_contacts.insert"]);
  const rows = audit ?? [];
  expect(rows.filter((r) => r.action === "client_contacts.insert")).toHaveLength(2);
  expect(rows.some((r) => r.action === "clients.update")).toBe(true);
  expect(rows.every((r) => r.actor_id === ops.userId && r.channel === "web")).toBe(true);
});
