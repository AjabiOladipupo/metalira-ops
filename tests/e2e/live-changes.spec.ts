import { expect, test, type Page } from "@playwright/test";

import { addDays, formatDate, lagosToday } from "../../src/lib/dates";
import { isoWeekday } from "../../src/lib/headcount";
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
const today = lagosToday();
const monday = addDays(today, 8 - isoWeekday(today));

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/**
 * A Coastline contract live from today at Apapa Warehouse 3 (Gate A · Day and Gate A · Night,
 * one guard each, every day), with Guard Day and Night rates, and the client's Lekki Gate (with
 * a geofence) not yet on the contract. Written with the secret key: activation has its own spec.
 */
async function seedLiveContract() {
  const admin = adminClient();
  const owner = await createOwner("live-owner", `Kola Guarding ${uniqueSuffix()}`);
  const ops = await createAccount("live-ops", "Obinna Okafor");
  await addMembership(owner.orgId, ops.userId, "ops_manager");
  const org = owner.orgId;

  const { data: clientId, error } = await admin.rpc("create_client", {
    p_organisation_id: org,
    p_name: "Coastline Logistics",
    p_contact_name: "Ngozi Eze",
    p_contact_email: "accounts@coastline.example",
  });
  expect(error).toBeNull();
  const sites = await admin
    .from("sites")
    .insert(
      ["Apapa Warehouse 3", "Lekki Gate"].map((name) => ({
        organisation_id: org,
        client_id: clientId!,
        name,
        centre: CENTRE,
      })) as never,
    )
    .select("id, name");
  expect(sites.error).toBeNull();
  const apapa = sites.data!.find((s) => s.name === "Apapa Warehouse 3")!.id;

  const contract = await admin
    .from("contracts")
    .insert({
      organisation_id: org,
      client_id: clientId!,
      reference: "",
      name: "Coastline guarding",
      type: "manned_post",
      start_date: today,
    } as never)
    .select("id")
    .single();
  expect(contract.error).toBeNull();
  const contractId = contract.data!.id;
  expect(
    (
      await admin
        .from("contract_sites")
        .insert({ organisation_id: org, contract_id: contractId, site_id: apapa })
    ).error,
  ).toBeNull();
  const card = await admin
    .from("rate_cards")
    .insert({ organisation_id: org, contract_id: contractId, effective_from: today })
    .select("id")
    .single();
  expect(card.error).toBeNull();
  const lines = await admin.from("rate_card_lines").insert(
    [
      { band: "Day", rate_kobo: 1_250_000 },
      { band: "Night", rate_kobo: 1_500_000 },
    ].map((l, i) => ({
      organisation_id: org,
      rate_card_id: card.data!.id,
      role: "Guard",
      unit: "shift",
      wht_rate_bps: 200,
      sort_order: i,
      ...l,
    })),
  );
  expect(lines.error).toBeNull();
  const live = await admin
    .from("contracts")
    .update({
      status: "active",
      go_live_date: today,
      activated_at: new Date().toISOString(),
    } as never)
    .eq("id", contractId);
  expect(live.error).toBeNull();
  for (const [band, start, end] of [
    ["Day", "06:00", "18:00"],
    ["Night", "18:00", "06:00"],
  ] as const) {
    const post = await admin
      .from("posts")
      .insert({
        organisation_id: org,
        contract_id: contractId,
        site_id: apapa,
        name: `Gate A · ${band}`,
        role: "Guard",
        band,
        unit: "shift",
        opened_on: today,
      })
      .select("id")
      .single();
    expect(post.error).toBeNull();
    const req = await admin.from("roster_requirements").insert({
      organisation_id: org,
      post_id: post.data!.id,
      contract_id: contractId,
      site_id: apapa,
      effective_from: today,
      days_of_week: [1, 2, 3, 4, 5, 6, 7],
      start_time: start,
      end_time: end,
      required_count: 1,
    });
    expect(req.error).toBeNull();
  }
  return { admin, ops, clientId: clientId!, contractId };
}

async function openPosts(page: Page, ops: { email: string; password: string }, path: string) {
  await signInViaUi(page, ops.email, ops.password);
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });
  await page.goto(`${path}?tab=posts`);
  await expect(page.getByTestId("post-row")).toHaveCount(2);
}

test("ops_manager raises Gate A · Night from 1 to 2 guards from next Monday", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { admin, ops, clientId, contractId } = await seedLiveContract();
  const page = await (await browser.newContext()).newPage();
  const base = `/app/clients/${clientId}/contracts/${contractId}`;
  await openPosts(page, ops, base);

  await page.getByRole("link", { name: "Gate A · Night" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Gate A · Night");
  await page.getByRole("link", { name: "Change headcount from…" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Change Gate A · Night");

  const form = page.getByRole("form", { name: "Change headcount" });
  await expect(form.getByLabel("From")).toHaveValue(monday);
  await form.getByLabel("People").fill("2");
  await form.getByLabel("Note").fill("Client asked for a second guard at night");
  await expect(page.getByTestId("change-summary")).toHaveText(
    `Gate A · Night: 1 → 2 people from ${formatDate(monday)}. 7 → 14 person-shifts (168 h) a week.`,
  );
  await expect(page.getByTestId("change-preview")).toContainText(
    `ends ${formatDate(addDays(monday, -1))}`,
  );
  await expectNoHorizontalScroll(page);
  await form.getByRole("button", { name: "Save change" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Gate A · Night", {
    timeout: 15_000,
  });
  const versions = page.getByTestId("post-versions").getByRole("listitem");
  await expect(versions).toHaveCount(2);
  await expect(page.getByTestId(`post-version-${monday}`)).toContainText("2 people");
  await expect(page.getByTestId(`post-version-${today}`)).toContainText("1 person");
  await expect(page.getByTestId(`post-version-${today}`)).toContainText(
    `${formatDate(today)} to ${formatDate(addDays(monday, -1))}`,
  );
  await expect(page.getByTestId("post-changes")).toContainText(
    `1 → 2 people from ${formatDate(monday)}`,
  );
  await expect(page.getByTestId("post-changes")).toContainText(
    "Client asked for a second guard at night",
  );
  await expectNoHorizontalScroll(page);

  const { data: post } = await admin
    .from("posts")
    .select("id")
    .eq("contract_id", contractId)
    .eq("name", "Gate A · Night")
    .single();
  const { data: audit } = await admin
    .from("audit_log")
    .select("actor_id, channel")
    .eq("action", "post.requirement_changed")
    .eq("entity_id", post!.id);
  expect(audit).toEqual([{ actor_id: ops.userId, channel: "web" }]);

  // Taking the change back before it starts: the first version runs on again.
  await page.getByRole("button", { name: `Cancel the change from ${formatDate(monday)}` }).click();
  await page.getByRole("button", { name: "Yes, cancel it" }).click();
  await expect(page.getByTestId("post-versions").getByRole("listitem")).toHaveCount(1, {
    timeout: 15_000,
  });
  await expect(page.getByTestId(`post-version-${today}`)).toContainText(
    `From ${formatDate(today)}`,
  );
  await expect(page.getByTestId("post-changes")).toContainText(
    `Change from ${formatDate(monday)} cancelled`,
  );
});

test("ops_manager adds a post at a client site not yet on the contract", async ({ browser }) => {
  test.setTimeout(180_000);
  const { admin, ops, clientId, contractId } = await seedLiveContract();
  const page = await (await browser.newContext()).newPage();
  const base = `/app/clients/${clientId}/contracts/${contractId}`;
  await openPosts(page, ops, base);

  await page.getByRole("link", { name: "Add post" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add post");
  const form = page.getByRole("form", { name: "Add post" });
  await form.getByLabel("Site").selectOption({ label: "Lekki Gate (adds it to the contract)" });
  await form.getByLabel("Post").fill("Gate C");
  await form.getByLabel("Role").fill("Supervisor");
  await form.getByLabel("Band").fill("Night");
  await form.getByLabel("Starts").fill("18:00");
  await form.getByLabel("Ends").fill("06:00");
  await expect(page.getByTestId("add-post-preview-refusal")).toHaveText(
    "No rate for Supervisor · Night (shift). Add it to the rate card first.",
  );
  await form.getByLabel("Role").fill("Guard");
  await expect(page.getByTestId("add-post-summary")).toHaveText(
    `Adds Gate C · Night at Lekki Gate (adds Lekki Gate to the contract) from ${formatDate(monday)}: Every day 18:00–06:00 (next day) × 1.`,
  );
  await expectNoHorizontalScroll(page);
  await form.getByRole("button", { name: "Add post" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Gate C · Night", {
    timeout: 15_000,
  });
  await expect(page.getByTestId(`post-version-${monday}`)).toContainText("1 person");
  await page.goto(`${base}?tab=posts`);
  await expect(page.getByTestId("post-row")).toHaveCount(3);
  await expect(page.getByRole("row", { name: "Gate C · Night at Lekki Gate" })).toBeVisible();

  const { data: changes } = await admin
    .from("contract_changes")
    .select("kind")
    .eq("contract_id", contractId)
    .order("created_at");
  expect(changes?.map((c) => c.kind)).toEqual(["site_added", "post_added"]);
});

test("ops_manager closes Gate A · Day after next Monday", async ({ browser }) => {
  test.setTimeout(180_000);
  const { ops, clientId, contractId } = await seedLiveContract();
  const page = await (await browser.newContext()).newPage();
  const base = `/app/clients/${clientId}/contracts/${contractId}`;
  await openPosts(page, ops, base);

  await page.getByRole("link", { name: "Gate A · Day" }).click();
  await page.getByRole("link", { name: "Close post" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Close Gate A · Day");
  const form = page.getByRole("form", { name: "Close post" });
  await form.getByLabel("Last day staffed").fill(monday);
  await form.getByLabel("Reason").fill("Client closed the day gate");
  await expect(page.getByTestId("close-preview")).toContainText(
    `Closes Gate A · Day after ${formatDate(monday)} (its last day staffed).`,
  );
  await expectNoHorizontalScroll(page);
  await form.getByRole("button", { name: "Close post" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Gate A · Day", {
    timeout: 15_000,
  });
  await expect(page.getByText("Closed", { exact: true })).toBeVisible();
  await expect(page.getByTestId(`post-version-${today}`)).toContainText(
    `${formatDate(today)} to ${formatDate(monday)}`,
  );
  await expect(page.getByTestId("post-changes")).toContainText("Client closed the day gate");
  // Closing after a later day, it can still be closed sooner (never later).
  await expect(page.getByRole("link", { name: "Close post" })).toBeVisible();
});
