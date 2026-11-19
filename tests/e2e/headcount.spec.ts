import { expect, test, type Page } from "@playwright/test";

import { lagosToday } from "../../src/lib/dates";
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

interface RowValues {
  site: string;
  post: string;
  band: string;
  starts: string;
  ends: string;
}

async function addRow(page: Page, values: RowValues, expectedRow: string) {
  await page.getByRole("link", { name: "Add headcount" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add headcount");
  const form = page.getByRole("form", { name: "Add headcount row" });
  await form.getByLabel("Site").selectOption({ label: values.site });
  await form.getByLabel("Post", { exact: true }).fill(values.post);
  await form.getByLabel("Role", { exact: true }).fill("Guard");
  await form.getByLabel("Band", { exact: true }).fill(values.band);
  await form.getByLabel("Starts").fill(values.starts);
  await form.getByLabel("Ends").fill(values.ends);
  await expect(page.getByTestId("headcount-row-preview")).toHaveText(expectedRow);
  await expectNoHorizontalScroll(page);
  await form.getByRole("button", { name: "Add row" }).click();
  await expect(page).toHaveURL(/\?tab=headcount$/, { timeout: 15_000 });
}

/**
 * Slice 2.5 (runs at 390px and 1440px through the Playwright projects): a draft manned-post
 * Coastline contract at Apapa Warehouse 3 and Gate B, with Guard Day ₦12,500 and Guard Night
 * ₦15,000 a shift, gets 4 headcount rows (Gate A · Day and Night, Patrol · Night, Warehouse
 * floor · Day). The weekly total is ₦385,000 to the naira; a Supervisor row with no rate line is
 * flagged, then removed.
 */
test("ops_manager adds 4 headcount rows at two sites and sees the weekly total", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const admin = adminClient();
  const suffix = uniqueSuffix();
  const owner = await createOwner("headcount-owner", `Kola Guarding ${suffix}`);
  const ops = await createAccount("headcount-ops", "Obinna Okafor");
  await addMembership(owner.orgId, ops.userId, "ops_manager");

  // The contract and its rate card, set up with the secret key (slice 2.4's screens are tested
  // in contracts.spec.ts).
  const { data: clientId, error } = await admin.rpc("create_client", {
    p_organisation_id: owner.orgId,
    p_name: "Coastline Logistics",
    p_contact_email: "accounts@coastline.example",
    p_site_name: "Apapa Warehouse 3",
  });
  expect(error).toBeNull();
  const gateB = await admin
    .from("sites")
    .insert({ organisation_id: owner.orgId, client_id: clientId!, name: "Gate B" })
    .select("id")
    .single();
  const { data: sites } = await admin.from("sites").select("id").eq("client_id", clientId!);
  const start = lagosToday();
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
  expect(gateB.error).toBeNull();
  const links = await admin.from("contract_sites").insert(
    (sites ?? []).map((s) => ({
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
  const lines = await admin.from("rate_card_lines").insert([
    {
      organisation_id: owner.orgId,
      rate_card_id: card.data!.id,
      role: "Guard",
      band: "Day",
      unit: "shift",
      rate_kobo: 1_250_000,
      ot_multiplier_bps: 15_000,
      sort_order: 0,
    },
    {
      organisation_id: owner.orgId,
      rate_card_id: card.data!.id,
      role: "Guard",
      band: "Night",
      unit: "shift",
      rate_kobo: 1_500_000,
      ot_multiplier_bps: 15_000,
      sort_order: 1,
    },
  ]);
  expect(lines.error).toBeNull();

  const page = await (await browser.newContext()).newPage();
  await signInViaUi(page, ops.email, ops.password);
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });

  await page.goto(`/app/clients/${clientId}/contracts/${contractId}?tab=headcount`);
  await expect(page.getByText("No headcount yet.")).toBeVisible();

  await addRow(
    page,
    { site: "Apapa Warehouse 3", post: "Gate A", band: "Day", starts: "06:00", ends: "18:00" },
    "Every day 06:00–18:00 × 1: 7 shifts a week · ₦87,500 a week",
  );
  await addRow(
    page,
    { site: "Apapa Warehouse 3", post: "Gate A", band: "Night", starts: "18:00", ends: "06:00" },
    "Every day 18:00–06:00 (next day) × 1: 7 shifts a week · ₦105,000 a week",
  );
  await addRow(
    page,
    { site: "Gate B", post: "Patrol", band: "Night", starts: "18:00", ends: "06:00" },
    "Every day 18:00–06:00 (next day) × 1: 7 shifts a week · ₦105,000 a week",
  );
  await addRow(
    page,
    { site: "Gate B", post: "Warehouse floor", band: "Day", starts: "06:00", ends: "18:00" },
    "Every day 06:00–18:00 × 1: 7 shifts a week · ₦87,500 a week",
  );

  const total = "4 posts · 28 shifts a week · ₦385,000 a week at today's rates";
  await expect(page.getByTestId("headcount-total")).toHaveText(total);
  await expect(page.getByTestId("headcount-row")).toHaveCount(4);
  const apapa = page.getByRole("list", { name: "Headcount at Apapa Warehouse 3" });
  await expect(apapa.getByRole("listitem")).toHaveCount(2);
  await expect(apapa.getByRole("listitem", { name: "Gate A · Night" })).toContainText(
    "18:00–06:00 (next day)",
  );
  await expect(page.getByText("2 posts · 14 shifts a week · ₦192,500 a week")).toHaveCount(2);
  await expect(page.getByTestId("headcount-unpriced")).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  // A Supervisor row has no rate line: flagged, and left out of the total.
  await addRow(
    page,
    { site: "Gate B", post: "Gate C", band: "Supervisor", starts: "06:00", ends: "18:00" },
    "Every day 06:00–18:00 × 1: 7 shifts a week · No rate for Guard · Supervisor",
  );
  await expect(page.getByTestId("headcount-total")).toHaveText(
    "5 posts · 35 shifts a week · ₦385,000 a week at today's rates",
  );
  await expect(page.getByTestId("headcount-unpriced")).toContainText(
    "1 row has no rate. Add Guard · Supervisor (shift) to the rate card before activating.",
  );
  await expect(page.getByRole("listitem", { name: "Gate C · Supervisor" })).toContainText(
    "No rate for Guard · Supervisor",
  );
  await expectNoHorizontalScroll(page);

  // Removed again, after a confirm.
  await page.getByRole("button", { name: "Remove Gate C · Supervisor at Gate B" }).click();
  await page.getByRole("button", { name: "Yes, remove" }).click();
  await expect(page.getByTestId("headcount-total")).toHaveText(total, { timeout: 15_000 });
  await expect(page.getByTestId("headcount-unpriced")).toHaveCount(0);

  // Saved by the ops manager through the manager app.
  const { data: audit } = await admin
    .from("audit_log")
    .select("action, actor_id, channel")
    .eq("organisation_id", owner.orgId)
    .like("action", "headcount_requirements.%");
  expect((audit ?? []).map((r) => r.action).sort()).toEqual([
    ...Array<string>(1).fill("headcount_requirements.delete"),
    ...Array<string>(5).fill("headcount_requirements.insert"),
  ]);
  expect((audit ?? []).every((r) => r.actor_id === ops.userId && r.channel === "web")).toBe(true);

  // Once the contract is live (activation is slice 2.7), the rows are frozen: no add or edit.
  await admin
    .from("contracts")
    .update({ status: "active" } as never)
    .eq("id", contractId);
  await page.reload();
  await expect(page.getByTestId("headcount-total")).toHaveText(total);
  await expect(page.getByRole("link", { name: "Add headcount" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
});
