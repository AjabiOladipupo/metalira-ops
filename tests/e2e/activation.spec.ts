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

const CENTRE = "SRID=4326;POINT(3.3611 6.4474)";

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/**
 * A draft manned-post Coastline contract at Apapa Warehouse 3 and Gate B, with Guard Day
 * ₦12,500 and Guard Night ₦15,000 a shift and 4 headcount rows, set up with the secret key
 * (the earlier slices' screens have their own specs). `gateBFenced` false leaves Gate B without
 * a geofence.
 */
async function seedCoastline(gateBFenced: boolean) {
  const admin = adminClient();
  const suffix = uniqueSuffix();
  const owner = await createOwner("activation-owner", `Kola Guarding ${suffix}`);
  const ops = await createAccount("activation-ops", "Obinna Okafor");
  await addMembership(owner.orgId, ops.userId, "ops_manager");

  const { data: clientId, error } = await admin.rpc("create_client", {
    p_organisation_id: owner.orgId,
    p_name: "Coastline Logistics",
    p_contact_name: "Ngozi Eze",
    p_contact_email: "accounts@coastline.example",
  });
  expect(error).toBeNull();
  const sites = await admin
    .from("sites")
    .insert([
      {
        organisation_id: owner.orgId,
        client_id: clientId!,
        name: "Apapa Warehouse 3",
        centre: CENTRE,
      },
      {
        organisation_id: owner.orgId,
        client_id: clientId!,
        name: "Gate B",
        ...(gateBFenced ? { centre: CENTRE } : {}),
      },
    ] as never)
    .select("id, name");
  expect(sites.error).toBeNull();
  const siteId = (name: string) => sites.data!.find((s) => s.name === name)!.id;

  const start = addDays(lagosToday(), 3);
  const contract = await admin
    .from("contracts")
    .insert({
      organisation_id: owner.orgId,
      client_id: clientId!,
      reference: "",
      name: "Coastline guarding",
      type: "manned_post",
      start_date: start,
    } as never)
    .select("id")
    .single();
  expect(contract.error).toBeNull();
  const contractId = contract.data!.id;
  const links = await admin.from("contract_sites").insert(
    sites.data!.map((s) => ({
      organisation_id: owner.orgId,
      contract_id: contractId,
      site_id: s.id,
    })),
  );
  expect(links.error).toBeNull();
  const card = await admin
    .from("rate_cards")
    .insert({ organisation_id: owner.orgId, contract_id: contractId, effective_from: start })
    .select("id")
    .single();
  expect(card.error).toBeNull();
  const lines = await admin.from("rate_card_lines").insert(
    [
      { band: "Day", rate_kobo: 1_250_000 },
      { band: "Night", rate_kobo: 1_500_000 },
    ].map((l, i) => ({
      organisation_id: owner.orgId,
      rate_card_id: card.data!.id,
      role: "Guard",
      unit: "shift",
      wht_rate_bps: 200,
      sort_order: i,
      ...l,
    })),
  );
  expect(lines.error).toBeNull();
  const rows = [
    ["Apapa Warehouse 3", "Gate A", "Day", "06:00", "18:00"],
    ["Apapa Warehouse 3", "Gate A", "Night", "18:00", "06:00"],
    ["Gate B", "Patrol", "Night", "18:00", "06:00"],
    ["Gate B", "Warehouse floor", "Day", "06:00", "18:00"],
  ] as const;
  const headcount = await admin.from("headcount_requirements").insert(
    rows.map(([site, post, band, startTime, endTime]) => ({
      organisation_id: owner.orgId,
      contract_id: contractId,
      site_id: siteId(site),
      post_name: post,
      role: "Guard",
      band,
      unit: "shift",
      days_of_week: [1, 2, 3, 4, 5, 6, 7],
      start_time: startTime,
      end_time: endTime,
      required_count: 1,
    })),
  );
  expect(headcount.error).toBeNull();
  return { admin, ops, clientId: clientId!, contractId, start };
}

test("ops_manager activates the Coastline contract and sees its 4 posts", async ({ browser }) => {
  test.setTimeout(180_000);
  const { admin, ops, clientId, contractId, start } = await seedCoastline(true);
  const page = await (await browser.newContext()).newPage();
  await signInViaUi(page, ops.email, ops.password);
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });

  await page.goto(`/app/clients/${clientId}/contracts/${contractId}`);
  await page.getByRole("link", { name: "Activate contract" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Activate contract");
  const checklist = page.getByTestId("activation-checklist");
  await expect(checklist.getByText("Missing")).toHaveCount(0);
  await expect(checklist.getByText("Ready")).toHaveCount(8);
  await expect(page.getByTestId("activation-summary")).toHaveText(
    `Creates 4 posts and 4 roster requirements from ${formatDate(start)}.`,
  );
  await expect(page.getByRole("checkbox", { name: /Send a welcome email/ })).toBeChecked();
  await expectNoHorizontalScroll(page);

  await page
    .getByRole("form", { name: "Activate contract" })
    .getByRole("button", { name: "Activate contract" })
    .click();
  await expect(page).toHaveURL(/\?tab=posts$/, { timeout: 15_000 });
  await expect(page.getByText("Active", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("post-row")).toHaveCount(4);
  await expect(
    page.getByRole("row", { name: "Gate A · Night at Apapa Warehouse 3" }),
  ).toContainText("18:00–06:00 (next day)");
  await expect(page.getByTestId("posts-summary")).toHaveText(
    `4 open posts · live from ${formatDate(start)}`,
  );
  await expectNoHorizontalScroll(page);

  // The database agrees, and the activation is audited as the ops manager.
  const { data: audit } = await admin
    .from("audit_log")
    .select("actor_id, channel")
    .eq("entity_id", contractId)
    .eq("action", "contract.activated");
  expect(audit).toEqual([{ actor_id: ops.userId, channel: "web" }]);

  // Ending it: the preview, then every post closes on the last day.
  await page.getByRole("link", { name: "End contract" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("End contract");
  const last = addDays(start, 27);
  const form = page.getByRole("form", { name: "End contract" });
  await form.getByLabel("Last day of service").fill(last);
  await form.getByLabel("Reason").fill("Client gave notice");
  await expect(page.getByTestId("end-preview")).toHaveText(
    `Closes 4 posts, their roster requirements and the rate card on ${formatDate(last)}. The contract ends after that day.`,
  );
  await form.getByRole("button", { name: "End contract" }).click();
  await expect(page).toHaveURL(/\?tab=posts$/, { timeout: 15_000 });
  await expect(page.getByTestId("posts-summary")).toContainText(
    `ends ${formatDate(last)} (Client gave notice)`,
  );
  await expect(page.getByText(`Closes after ${formatDate(last)}`)).toHaveCount(4);
});

test("activation lists what is missing when a site has no geofence", async ({ browser }) => {
  test.setTimeout(120_000);
  const { admin, ops, clientId, contractId } = await seedCoastline(false);
  const page = await (await browser.newContext()).newPage();
  await signInViaUi(page, ops.email, ops.password);
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });
  await page.goto(`/app/clients/${clientId}/contracts/${contractId}/activate`);

  const geofence = page.getByRole("listitem", { name: "Sites with a geofence" });
  await expect(geofence).toContainText("Missing");
  await expect(geofence).toContainText("No geofence at Gate B. Set one on each site.");
  await expect(geofence.getByRole("link", { name: "Open the sites" })).toHaveAttribute(
    "href",
    `/app/clients/${clientId}?tab=sites`,
  );
  await expect(page.getByText("Fix the items above, then come back to activate.")).toBeVisible();
  await expect(
    page.getByRole("form", { name: "Activate contract" }).getByRole("button"),
  ).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  // Still a draft with no posts.
  const { count } = await admin
    .from("posts")
    .select("id", { count: "exact", head: true })
    .eq("contract_id", contractId);
  expect(count).toBe(0);
});
