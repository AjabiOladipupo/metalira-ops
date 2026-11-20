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
/** Next Monday (never today): the first full week the contract is live. */
const weekOne = addDays(today, 8 - isoWeekday(today));
const weekTwo = addDays(weekOne, 7);

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/**
 * A Coastline contract live from today at Apapa Warehouse 3 (Gate A · Day 06:00–18:00 and
 * Gate A · Night 18:00–06:00, one guard each, every day), an ops manager, and three guards
 * mapped to Apapa. Written with the secret key: activation has its own spec.
 */
async function seedRoster() {
  const admin = adminClient();
  const owner = await createOwner("roster-owner", `Kola Guarding ${uniqueSuffix()}`);
  const ops = await createAccount("roster-ops", "Obinna Okafor");
  await addMembership(owner.orgId, ops.userId, "ops_manager");
  const org = owner.orgId;

  const { data: clientId, error } = await admin.rpc("create_client", {
    p_organisation_id: org,
    p_name: "Coastline Logistics",
    p_contact_name: "Ngozi Eze",
    p_contact_email: "accounts@coastline.example",
  });
  expect(error).toBeNull();
  const site = await admin
    .from("sites")
    .insert({
      organisation_id: org,
      client_id: clientId!,
      name: "Apapa Warehouse 3",
      centre: CENTRE,
    } as never)
    .select("id")
    .single();
  expect(site.error).toBeNull();
  const apapa = site.data!.id;

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
  const live = await admin
    .from("contracts")
    .update({
      status: "active",
      go_live_date: today,
      activated_at: new Date().toISOString(),
    } as never)
    .eq("id", contractId);
  expect(live.error).toBeNull();
  const posts: Record<string, string> = {};
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
    posts[band] = post.data!.id;
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

  const workers: Record<string, string> = {};
  for (const [i, [first, last]] of [
    ["Musa", "Ibrahim"],
    ["Yusuf", "Bello"],
    ["Daniel", "Okafor"],
  ].entries()) {
    const w = await admin
      .from("workers")
      .insert({
        organisation_id: org,
        staff_id: `EMP-000${i + 1}`,
        first_name: first!,
        last_name: last!,
        employment_type: "permanent",
        start_date: "2025-01-06",
      })
      .select("id")
      .single();
    expect(w.error).toBeNull();
    workers[first!] = w.data!.id;
    const map = await admin.from("worker_assignments").insert({
      organisation_id: org,
      worker_id: w.data!.id,
      site_id: apapa,
      effective_from: "2025-01-06",
    });
    expect(map.error).toBeNull();
  }
  return { admin, ops, org, apapa, posts, workers };
}

/** Assigns with the secret key (the guards still check it). */
async function seedAssignment(
  seed: Awaited<ReturnType<typeof seedRoster>>,
  postId: string,
  date: string,
  workerId: string,
) {
  const post = await seed.admin.from("posts").select("contract_id").eq("id", postId).single();
  expect(post.error).toBeNull();
  // The guard fills the times and people from the post's requirement.
  const shift = await seed.admin
    .from("shifts")
    .insert({
      organisation_id: seed.org,
      post_id: postId,
      contract_id: post.data!.contract_id,
      site_id: seed.apapa,
      shift_date: date,
      starts_at: new Date().toISOString(),
      ends_at: new Date(Date.now() + 60_000).toISOString(),
      required_count: 1,
    })
    .select("id")
    .single();
  expect(shift.error).toBeNull();
  const shiftId = shift.data!.id;
  const row = await seed.admin.from("shift_assignments").insert({
    organisation_id: seed.org,
    shift_id: shiftId,
    site_id: seed.apapa,
    shift_date: date,
    worker_id: workerId,
    starts_at: new Date().toISOString(),
    ends_at: new Date(Date.now() + 60_000).toISOString(),
  });
  expect(row.error).toBeNull();
}

async function openRoster(page: Page, ops: { email: string; password: string }, path: string) {
  await signInViaUi(page, ops.email, ops.password);
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });
  await page.goto(path);
}

test("ops_manager assigns a suggested worker into an uncovered shift", async ({ browser }) => {
  test.setTimeout(180_000);
  const seed = await seedRoster();
  const page = await (await browser.newContext()).newPage();
  await openRoster(page, seed.ops, `/app/roster?site=${seed.apapa}&week=${weekOne}`);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    `Week of ${formatDate(weekOne)}`,
  );
  await expect(page.getByText("0 of 14 shifts covered · 14 open")).toBeVisible();
  await expect(page.getByRole("link", { name: "Publish roster" })).toBeVisible();
  await expect(page.getByTestId("publication-status")).toHaveText("Not published");

  const tray = page.getByTestId("uncovered-tray");
  await expect(tray.getByText("14 open")).toBeVisible();
  const card = tray.getByTestId("tray-card").first();
  await expect(card).toContainText("Gate A · Day");
  await expect(card).toContainText("Off Monday · 0 h this week");
  const assign = card.getByRole("button", { name: /^Assign / });
  const name = (await assign.textContent())!.replace("Assign ", "").trim();
  await assign.click();
  await expect(page.getByText(new RegExp(`^${name} [A-Za-z'-]+ assigned · `))).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("1 of 14 shifts covered · 13 open")).toBeVisible();

  // The picker from an Uncovered chip: suggestions first, then assign.
  await page
    .getByRole("button", { name: /^Uncovered: Gate A · Night, Mon/ })
    .first()
    .click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: "Gate A · Night" })).toBeVisible();
  const suggestions = sheet.getByTestId("picker-suggestions").getByRole("listitem");
  await expect(suggestions.first()).toContainText("Off Monday");
  await sheet.getByRole("searchbox").fill("Daniel");
  await sheet.getByRole("button", { name: "Assign Daniel" }).click();
  await expect(page.getByText("2 of 14 shifts covered · 12 open")).toBeVisible({
    timeout: 15_000,
  });

  // Remove again, with a reason.
  await page
    .getByRole("button", { name: /^Daniel Okafor, Gate A · Night, Mon .*Remove from shift$/ })
    .first()
    .click();
  const remove = page.getByRole("dialog");
  await remove.getByLabel("Reason (optional)").fill("Swapped with the day team");
  await remove.getByRole("button", { name: "Remove from shift" }).click();
  await expect(page.getByText("1 of 14 shifts covered · 13 open")).toBeVisible({
    timeout: 15_000,
  });
  const { data: removed } = await seed.admin
    .from("shift_assignments")
    .select("status, removed_reason")
    .eq("worker_id", seed.workers.Daniel!)
    .eq("status", "removed");
  expect(removed).toEqual([{ status: "removed", removed_reason: "Swapped with the day team" }]);
  await expectNoHorizontalScroll(page);
});

test("ops_manager copies last week after the preview", async ({ browser }) => {
  test.setTimeout(180_000);
  const seed = await seedRoster();
  await seedAssignment(seed, seed.posts.Day!, weekOne, seed.workers.Musa!);
  await seedAssignment(seed, seed.posts.Night!, addDays(weekOne, 1), seed.workers.Yusuf!);
  const page = await (await browser.newContext()).newPage();
  await openRoster(page, seed.ops, `/app/roster?site=${seed.apapa}&week=${weekTwo}`);
  await expect(page.getByText("0 of 14 shifts covered · 14 open")).toBeVisible();

  await page.getByRole("link", { name: "Copy last week" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Copy last week", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("copy-preview")).toHaveText(
    `Copies 2 assignments into the week of ${formatDate(weekTwo)}.`,
  );
  await expectNoHorizontalScroll(page);
  await page.getByRole("button", { name: "Copy 2 assignments" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    `Week of ${formatDate(weekTwo)}`,
    { timeout: 15_000 },
  );
  await expect(page.getByText("2 of 14 shifts covered · 12 open")).toBeVisible();
  const { count } = await seed.admin
    .from("shift_assignments")
    .select("id", { count: "exact", head: true })
    .eq("organisation_id", seed.org)
    .gte("shift_date", weekTwo);
  expect(count).toBe(2);
});

test("at 390px the roster shows one day at a time", async ({ browser }, info) => {
  test.skip(info.project.name !== "mobile-390", "Phone layout only");
  test.setTimeout(180_000);
  const seed = await seedRoster();
  await seedAssignment(seed, seed.posts.Day!, addDays(weekOne, 1), seed.workers.Musa!);
  const page = await (
    await browser.newContext({ viewport: { width: 390, height: 844 } })
  ).newPage();
  await openRoster(page, seed.ops, `/app/roster?site=${seed.apapa}&week=${weekOne}`);

  await expect(page.getByTestId("roster-grid")).toBeHidden();
  const dayView = page.getByTestId("roster-day-view");
  await expect(dayView).toBeVisible();
  await expect(dayView.getByRole("tab")).toHaveCount(7);
  await expect(dayView.getByRole("tab", { selected: true })).toHaveAccessibleName(/^Monday/);
  await expect(dayView.getByTestId("roster-day-post")).toHaveCount(2);
  await expect(dayView.getByText("Musa I.")).toHaveCount(0);

  await dayView.getByRole("tab", { name: /^Tuesday/ }).click();
  await expect(dayView.getByText("Required 2 · Scheduled 1")).toBeVisible();
  await expect(dayView.getByText("Musa I.")).toBeVisible();
  await expect(dayView.getByRole("button", { name: /^Uncovered: Gate A · Night/ })).toHaveCount(1);
  await expectNoHorizontalScroll(page);
});
