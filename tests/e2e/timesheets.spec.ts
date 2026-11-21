/**
 * Slice 4.3: timesheet approval on /app/timesheets and "This is wrong" on /m/hours.
 * - An owner approves the clean days with the preview, adjusts a missing clock-out (preview,
 *   then save) and approves it; each approved manned-post day makes one billable Work Unit.
 * - A worker disputes their own day from the phone.
 * Contracts, posts, shifts and assignments are seeded as the database owner with triggers off
 * for the transaction (session_replication_role = replica), three days ago so the shifts are over;
 * punches are inserted as the database owner.
 */
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { addDays, lagosToday } from "../../src/lib/dates";
import { adminClient, anonClient, pgClient } from "../rls/helpers/supabase";
import {
  NEEDS_SUPABASE,
  createOwner,
  signInViaUi,
  supabaseReady,
  uniqueSuffix,
} from "./helpers/auth";

test.skip(!supabaseReady, NEEDS_SUPABASE);

const PIN = "583104";
const CENTRE = "SRID=4326;POINT(3.3611 6.4474)";
const DAY = addDays(lagosToday(), -3);
const at = (time: string) => new Date(`${DAY}T${time}:00+01:00`);

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function seed() {
  const admin = adminClient();
  const owner = await createOwner("ts-approve", `Kola Guarding ${uniqueSuffix()}`);
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
  const contract = randomUUID();
  const people = [
    { first: "Musa", last: "Bello", out: true },
    { first: "Halima", last: "Sani", out: true },
    { first: "Ngozi", last: "Eze", out: false },
  ];
  const ids: Record<string, string> = {};
  const db = await pgClient();
  try {
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
    await db.query(
      `insert into public.contracts (id, organisation_id, client_id, reference, name, type, start_date, vat_applies, status)
       values ($1, $2, $3, $4, 'Guarding', 'manned_post', '2025-01-01', false, 'active')`,
      [contract, org, clientId, `TS-${contract.slice(0, 6)}`],
    );
    await db.query("commit");
    for (const [i, p] of people.entries()) {
      const w = await admin
        .from("workers")
        .insert({
          organisation_id: org,
          staff_id: `EMP-10${i}`,
          first_name: p.first,
          last_name: p.last,
          employment_type: "permanent",
          start_date: "2025-01-06",
        })
        .select("id")
        .single();
      expect(w.error).toBeNull();
      const [post, shift, assignment] = [randomUUID(), randomUUID(), randomUUID()];
      await db.query("begin");
      await db.query("set local session_replication_role = replica");
      await db.query(
        `insert into public.posts (id, organisation_id, contract_id, site_id, name, role, band, unit, opened_on)
         values ($1, $2, $3, $4, $5, 'Guard', 'Day', 'shift', $6)`,
        [post, org, contract, apapa, `Gate ${String.fromCharCode(65 + i)} · Day`, DAY],
      );
      await db.query(
        `insert into public.shifts (id, organisation_id, post_id, contract_id, site_id, shift_date, starts_at, ends_at, required_count)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 1)`,
        [shift, org, post, contract, apapa, DAY, at("07:00"), at("19:00")],
      );
      await db.query(
        `insert into public.shift_assignments (id, organisation_id, shift_id, site_id, shift_date, worker_id, starts_at, ends_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [assignment, org, shift, apapa, DAY, w.data!.id, at("07:00"), at("19:00")],
      );
      await db.query("commit");
      const punch = (kind: "in" | "out", when: Date) =>
        db.query(
          `insert into public.punches (organisation_id, worker_id, kind, recorded_by_user, client_event_id,
             shift_assignment_id, site_id, device_time, received_at, recorded_at, time_source,
             clock_drift_seconds, geofence_result, distance_m, flags, payload_hash)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8, 'elapsed', 0, 'inside', 18, '{}',
             md5(gen_random_uuid()::text))`,
          [org, w.data!.id, kind, randomUUID(), randomUUID(), assignment, apapa, when],
        );
      await punch("in", at(p.out ? "07:00" : "07:02"));
      if (p.out) await punch("out", at("19:00"));
      ids[p.first] = w.data!.id;
    }
  } finally {
    await db.end();
  }
  return { owner, ids };
}

async function workUnits(orgId: string) {
  const { data, error } = await adminClient()
    .from("work_units")
    .select("id, billable, quantity_minutes, status")
    .eq("organisation_id", orgId);
  if (error) throw new Error(error.message);
  return data;
}

test("approve clean days, adjust a missing clock-out, and see billable Work Units", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { owner } = await seed();
  await signInViaUi(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });
  // The days are three days ago, which can fall in the previous pay period.
  await page.goto(`/app/timesheets?period=${DAY}`);

  // Opening the page builds the days from the punches.
  await expect(page.getByTestId("timesheets-headline")).toHaveText("3 timesheets to decide");
  await expect(page.getByTestId("timesheet-row")).toHaveCount(3);
  // The flagged day comes first.
  await expect(page.getByTestId("timesheet-row").first()).toContainText("Ngozi Eze");
  await expect(page.getByTestId("timesheet-row").first()).toContainText("No clock-out");
  await expectNoHorizontalScroll(page);

  await page.getByTestId("approve-clean").click();
  const preview = page.getByTestId("clean-preview");
  await expect(preview).toContainText("Approves 2 days.");
  await page.getByTestId("confirm-clean").click();
  await expect(page.getByTestId("clean-result")).toHaveText("2 days approved");
  await expect(page.getByTestId("timesheets-headline")).toHaveText("1 timesheet to decide");

  // Adjust Ngozi's missing clock-out: preview first, then save.
  await page.getByTestId("timesheet-row").filter({ hasText: "Ngozi Eze" }).click();
  const detail = page.getByTestId("timesheet-detail");
  await expect(detail).toContainText("No clock-out");
  await detail.getByRole("button", { name: "Adjust hours" }).click();
  await detail.getByLabel("Time on the company's clock").fill(`${DAY}T19:00`);
  await detail.getByLabel("Reason").fill("Gate book shows 19:00");
  await detail.getByRole("button", { name: "Check the new hours" }).click();
  await expect(detail.getByTestId("correction-preview")).toHaveText(
    "Now 0 min worked. After: 12 h worked.",
  );
  await detail.getByRole("button", { name: "Save correction" }).click();
  await expect(detail.getByTestId("correction-saved")).toHaveText("Corrected · 12 h worked");

  await detail.getByTestId("approve-day").click();
  await expect(detail.getByTestId("decision-result")).toHaveText(
    "Approved · 12 h worked · billable Work Unit made",
  );
  await expect(page.getByTestId("timesheets-headline")).toHaveText("All timesheets decided");

  const units = await workUnits(owner.orgId);
  expect(units).toHaveLength(3);
  expect(
    units.every((u) => u.billable && u.status === "approved" && u.quantity_minutes === 720),
  ).toBe(true);
  await expectNoHorizontalScroll(page);
});

test("a worker says a day is wrong from /m/hours", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-390", "The worker app is phone-first.");
  test.setTimeout(150_000);
  const { owner, ids } = await seed();
  const ownerClient = anonClient();
  await ownerClient.auth.signInWithPassword({ email: owner.email, password: owner.password });
  const invite = await ownerClient.rpc("create_worker_invites", {
    p_organisation_id: owner.orgId,
    p_worker_ids: [ids.Halima!],
    p_sent_via: "print",
  });
  if (invite.error) throw new Error(invite.error.message);
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.goto(`/m/invite/${invite.data![0]!.token}`);
  await page.getByLabel("New PIN").fill(PIN);
  await page.getByLabel("Type the PIN again").fill(PIN);
  await page.getByRole("checkbox", { name: /I have read this/ }).check();
  await page.getByRole("button", { name: "Set PIN and sign in" }).click();
  await expect(page).toHaveURL(/\/m$/, { timeout: 15_000 });

  await page.getByRole("link", { name: "My hours" }).click();
  await expect(page).toHaveURL(/\/m\/hours$/);
  // The day is three days ago, which can fall in the previous pay period.
  await page.goto(`/m/hours?period=${DAY}`);
  const day = page.getByTestId("my-day");
  await expect(day).toHaveCount(1);
  await expect(day.getByTestId("my-day-minutes")).toHaveText("12 h");
  await day.getByTestId("dispute-open").click();
  await day.getByLabel("What is wrong with this day?").fill("I stayed until 19:30 to hand over");
  await day.getByRole("button", { name: "Send to my manager" }).click();
  await expect(page.getByTestId("dispute-sent")).toBeVisible();
  await page.goto(`/m/hours?period=${DAY}`);
  await expect(page.getByTestId("my-day")).toHaveAttribute("data-status", "disputed");
  await expect(page.getByTestId("my-day")).toContainText("You said: I stayed until 19:30");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await context.close();
});
