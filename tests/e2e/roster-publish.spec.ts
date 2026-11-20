/**
 * Slice 3.3: an ops manager publishes this week's roster after the confirm step; the status line
 * shows the version; the worker sees the shift on My shifts and on the home card, with a message
 * in the inbox. After one person is taken off, the cell is marked "Changed since publish", and the
 * republish tells only that person.
 */
import { expect, test, type Page } from "@playwright/test";

import { lagosToday } from "../../src/lib/dates";
import { mondayOf } from "../../src/lib/roster";
import { adminClient, anonClient } from "../rls/helpers/supabase";
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
const PIN = "482913";
const today = lagosToday();
const thisWeek = mondayOf(today);

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/**
 * A contract live from today at Apapa Warehouse 3 (Gate A · Day 06:00–18:00, Gate A · Night
 * 18:00–06:00, one guard each, every day), an ops manager, Musa on today's day shift and Yusuf on
 * tonight's night shift. Written with the secret key; the guards still check every row.
 */
async function seed() {
  const admin = adminClient();
  const suffix = uniqueSuffix();
  const owner = await createOwner("publish-owner", `Kola Guarding ${suffix}`);
  const ops = await createAccount("publish-ops", "Obinna Okafor");
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
      landmark: "Opposite the Tin Can gate",
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
  expect(
    (
      await admin
        .from("contracts")
        .update({
          status: "active",
          go_live_date: today,
          activated_at: new Date().toISOString(),
        } as never)
        .eq("id", contractId)
    ).error,
  ).toBeNull();

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
  ].entries()) {
    const w = await admin
      .from("workers")
      .insert({
        organisation_id: org,
        staff_id: `PB-${suffix.slice(0, 4)}${i}`,
        first_name: first!,
        last_name: last!,
        employment_type: "permanent",
        start_date: "2025-01-06",
      })
      .select("id")
      .single();
    expect(w.error).toBeNull();
    workers[first!] = w.data!.id;
  }

  const assignments: Record<string, string> = {};
  for (const [band, name] of [
    ["Day", "Musa"],
    ["Night", "Yusuf"],
  ] as const) {
    const shift = await admin
      .from("shifts")
      .insert({
        organisation_id: org,
        post_id: posts[band]!,
        contract_id: contractId,
        site_id: apapa,
        shift_date: today,
        starts_at: new Date().toISOString(),
        ends_at: new Date(Date.now() + 60_000).toISOString(),
        required_count: 1,
      })
      .select("id")
      .single();
    expect(shift.error).toBeNull();
    const row = await admin
      .from("shift_assignments")
      .insert({
        organisation_id: org,
        shift_id: shift.data!.id,
        site_id: apapa,
        shift_date: today,
        worker_id: workers[name]!,
        starts_at: new Date().toISOString(),
        ends_at: new Date(Date.now() + 60_000).toISOString(),
      })
      .select("id")
      .single();
    expect(row.error).toBeNull();
    assignments[name] = row.data!.id;
  }

  // Musa's worker app invite.
  const ownerClient = anonClient();
  await ownerClient.auth.signInWithPassword({ email: owner.email, password: owner.password });
  const invite = await ownerClient.rpc("create_worker_invites", {
    p_organisation_id: org,
    p_worker_ids: [workers.Musa!],
    p_sent_via: "print",
  });
  expect(invite.error).toBeNull();
  return { admin, ops, org, apapa, posts, workers, assignments, token: invite.data![0]!.token };
}

async function inboxCount(admin: ReturnType<typeof adminClient>, workerId: string) {
  const { count } = await admin
    .from("inbox_items")
    .select("id", { count: "exact", head: true })
    .eq("worker_id", workerId)
    .eq("kind", "shift_published");
  return count ?? 0;
}

test("ops publishes the week, the worker sees the shift, and a republish tells only who changed", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop-1440", "One run: the worker part opens a phone context");
  test.setTimeout(240_000);
  const s = await seed();
  const roster = `/app/roster?site=${s.apapa}&week=${thisWeek}`;

  const page = await (await browser.newContext()).newPage();
  await signInViaUi(page, s.ops.email, s.ops.password);
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });
  await page.goto(roster);
  await expect(page.getByTestId("publication-status")).toHaveText("Not published");

  // Confirm step: the counts and who is told.
  await page.getByRole("link", { name: "Publish roster" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Publish roster", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("publish-preview")).toContainText("Publishes version 1");
  await expect(page.getByTestId("publish-preview")).toContainText("2 workers are told.");
  await expect(page.getByTestId("publish-affected").getByRole("listitem")).toHaveCount(2);
  await page.getByRole("button", { name: "Publish roster" }).click();
  await expect(page.getByTestId("publish-result")).toHaveText(
    "Published version 1 · 2 workers told in the app, 0 by email.",
    { timeout: 30_000 },
  );
  expect(await inboxCount(s.admin, s.workers.Musa!)).toBe(1);
  expect(await inboxCount(s.admin, s.workers.Yusuf!)).toBe(1);

  await page.getByRole("link", { name: "Back to the roster" }).click();
  await expect(page.getByTestId("publication-status")).toContainText(
    /^Published · version 1 · \d{1,2} [A-Z][a-z]{2} \d{2}:\d{2}/,
    { timeout: 15_000 },
  );
  await expect(page.getByRole("button", { name: "Published" })).toBeDisabled();

  // The worker, on a phone.
  const phone = await browser.newContext({
    baseURL: info.project.use.baseURL,
    viewport: { width: 390, height: 844 },
  });
  const w = await phone.newPage();
  await w.goto(`/m/invite/${s.token}`);
  await w.getByLabel("New PIN").fill(PIN);
  await w.getByLabel("Type the PIN again").fill(PIN);
  await w.getByRole("checkbox", { name: /I have read this/ }).check();
  await w.getByRole("button", { name: "Set PIN and sign in" }).click();
  await expect(w).toHaveURL(/\/m$/, { timeout: 15_000 });
  const card = w.getByTestId("shift-today");
  await expect(card).toContainText("06:00–18:00");
  await expect(card).toContainText("Gate A · Day · Apapa Warehouse 3");
  await expect(card).toContainText("Opposite the Tin Can gate");
  await expectNoHorizontalScroll(w);

  await w.goto("/m/shifts");
  await expect(w.getByRole("heading", { level: 1 })).toHaveText("My shifts");
  const mine = w.getByTestId("shifts-upcoming").getByTestId("my-shift");
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText("Gate A · Day at Apapa Warehouse 3");
  await expect(w.getByTestId("shifts-upcoming").getByTestId("shift-day")).toContainText("Today");
  await expectNoHorizontalScroll(w);

  await w.goto("/m/inbox");
  const message = w.getByTestId("inbox-item");
  await expect(message).toHaveCount(1);
  await expect(message).toContainText("Your shifts for the week of");
  await expect(message).toContainText("Gate A · Day");
  await expect(message.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/m/shifts");

  // Yusuf is taken off tonight's shift: the cell is marked, and the republish tells only him.
  const removed = await s.admin
    .from("shift_assignments")
    .update({ status: "removed" })
    .eq("id", s.assignments.Yusuf!);
  expect(removed.error).toBeNull();
  await page.goto(roster);
  await expect(page.getByTestId("publication-status")).toContainText(
    "Changes for 1 worker not published yet",
  );
  await expect(page.getByTestId("changed-since-publish").first()).toBeVisible();
  await page.getByRole("link", { name: "Publish roster" }).click();
  await expect(page.getByTestId("publish-preview")).toContainText(
    "1 worker taken off. Only this worker is told.",
  );
  await page.getByRole("button", { name: "Publish version 2" }).click();
  await expect(page.getByTestId("publish-result")).toHaveText(
    "Published version 2 · 1 worker told in the app, 0 by email.",
    { timeout: 30_000 },
  );
  expect(await inboxCount(s.admin, s.workers.Musa!)).toBe(1);
  expect(await inboxCount(s.admin, s.workers.Yusuf!)).toBe(2);
  const latest = await s.admin
    .from("inbox_items")
    .select("title, body")
    .eq("worker_id", s.workers.Yusuf!)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  expect(latest.data!.title).toMatch(/^Your shifts changed for the week of /);
  expect(latest.data!.body).toMatch(/^You are no longer on any shift at Apapa Warehouse 3/);
});
