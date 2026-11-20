import { expect, test, type Page } from "@playwright/test";

import { addDays, formatDate, lagosToday } from "../../src/lib/dates";
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

async function fillLine(
  page: Page,
  index: number,
  values: { role: string; band: string; rate: string; otRate: string; otMultiplier: string },
) {
  const line = page.getByRole("listitem", { name: `Rate line ${index}` });
  await line.getByRole("textbox", { name: "Role" }).fill(values.role);
  await line.getByRole("textbox", { name: "Band" }).fill(values.band);
  await line.getByRole("textbox", { name: "Rate (₦)", exact: true }).fill(values.rate);
  await line.getByRole("textbox", { name: "Overtime rate per hour (₦)" }).fill(values.otRate);
  await line.getByRole("textbox", { name: "Overtime multiplier" }).fill(values.otMultiplier);
}

/**
 * Slice 2.4 (runs at 390px and 1440px through the Playwright projects): ops_manager creates a
 * draft Coastline contract, enters its rate card (Guard Day ₦12,500 a shift, Guard Night
 * ₦15,000 a shift, each with its own overtime rate and 1.5×), then schedules a rate change from a
 * future date, checks the preview and sees both versions.
 */
test("ops_manager adds a Coastline contract, its rate card and a scheduled rate change", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const suffix = uniqueSuffix();
  const owner = await createOwner("contracts-owner", `Kola Guarding ${suffix}`);
  const ops = await createAccount("contracts-ops", "Obinna Okafor");
  await addMembership(owner.orgId, ops.userId, "ops_manager");
  const { data: clientId, error } = await adminClient().rpc("create_client", {
    p_organisation_id: owner.orgId,
    p_name: "Coastline Logistics",
    p_contact_email: "accounts@coastline.example",
    p_site_name: "Apapa Warehouse 3",
  });
  expect(error).toBeNull();

  const page = await (await browser.newContext()).newPage();
  await signInViaUi(page, ops.email, ops.password);
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });

  await page.goto(`/app/clients/${clientId}?tab=contracts`);
  await expect(page.getByText("No contracts yet.")).toBeVisible();
  await page.getByRole("link", { name: "Add contract" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add contract");
  await page.getByRole("textbox", { name: "Contract name" }).fill("Coastline guarding");
  await page.getByRole("checkbox", { name: "Apapa Warehouse 3" }).check();
  await expectNoHorizontalScroll(page);
  await page.getByRole("button", { name: "Add contract" }).click();

  await expect(page).toHaveURL(/\/contracts\/[0-9a-f-]{36}\?tab=rates$/, { timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Coastline guarding");
  await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: "Add rate card" }).click();

  // The draft rate card.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Rate card");
  await fillLine(page, 1, {
    role: "Guard",
    band: "Day",
    rate: "12,500",
    otRate: "1,600",
    otMultiplier: "1.5",
  });
  await page.getByRole("button", { name: "Add line" }).click();
  await fillLine(page, 2, {
    role: "Guard",
    band: "Night",
    rate: "15000",
    otRate: "1,900",
    otMultiplier: "1.5",
  });
  await expectNoHorizontalScroll(page);
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByTestId("rate-preview-summary")).toContainText("Adds the rate card from");
  await page.getByRole("button", { name: "Save rate card" }).click();

  await expect(page).toHaveURL(/\?tab=rates$/, { timeout: 15_000 });
  const versions = page.getByRole("list", { name: "Rate card versions" });
  await expect(versions.getByRole("listitem")).toHaveCount(1);
  // Each line's WHT follows its service type (2% on services).
  await expect(versions).toContainText("Services · 2%");
  await expect(versions).toContainText(
    "₦12,500 day (overtime ₦1,600 an hour) · ₦15,000 night shift (overtime ₦1,900 an hour)",
  );
  await expectNoHorizontalScroll(page);

  // "Change rates from" a future date: the preview says what closes and what changes.
  const from = addDays(lagosToday(), 45);
  await page.getByRole("link", { name: "Change rates from" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Change rates from");
  await page.getByLabel("New rates from").fill(from);
  await page
    .getByRole("listitem", { name: "Rate line 1" })
    .getByRole("textbox", { name: "Rate (₦)", exact: true })
    .fill("13,000");
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByTestId("rate-preview-summary")).toHaveText(
    `Changes 1 line from ${formatDate(from)}; 1 line stays the same. The current rates end on ${formatDate(addDays(from, -1))}.`,
  );
  await expect(page.getByText("₦12,500 a shift, overtime ₦1,600 an hour")).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.getByRole("button", { name: "Save rate change" }).click();

  await expect(page).toHaveURL(/\?tab=rates$/, { timeout: 15_000 });
  await expect(versions.getByRole("listitem")).toHaveCount(2);
  await expect(page.getByTestId(`rate-version-${from}`)).toContainText("₦13,000");
  await expect(page.getByTestId(`rate-version-${from}`)).toContainText("Scheduled");
  await expect(versions).toContainText(`to ${formatDate(addDays(from, -1))}`);
  await expectNoHorizontalScroll(page);

  // The client's Contracts tab lists it with its rates.
  await page.goto(`/app/clients/${clientId}?tab=contracts`);
  await expect(page.getByTestId("contract-rates")).toContainText("₦12,500 day");

  // Saved by the ops manager through the manager app, with the rate events.
  const { data: audit } = await adminClient()
    .from("audit_log")
    .select("action, actor_id, channel")
    .eq("organisation_id", owner.orgId)
    .in("action", ["rate_card.draft_saved", "rate_card.version_added"]);
  expect((audit ?? []).map((r) => r.action).sort()).toEqual([
    "rate_card.draft_saved",
    "rate_card.version_added",
  ]);
  expect((audit ?? []).every((r) => r.actor_id === ops.userId && r.channel === "web")).toBe(true);
});
