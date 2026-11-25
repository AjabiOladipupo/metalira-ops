/**
 * Slice U.2: bulk actions and CSV export on the lists.
 * - Timesheets at 1440px: tick three clean days and one without a clock-out, preview "3 will be
 *   approved, 1 skipped" with the reason, confirm, and the three are approved.
 * - Leave at 390px: tick two requests, preview, approve; they move on to HR.
 * - Clients: tick one client and export it; the file holds that client and no contact details.
 * - /app/export (security review L5): a line manager's export holds only their reportees; a role
 *   without payroll gets 403 on a payroll export; a cross-origin post gets 403; the audit row
 *   holds the count only.
 * Timesheet contracts, posts, shifts and assignments are seeded as the database owner with
 * triggers off for the transaction, three days ago so the shifts are over (as timesheets.spec.ts);
 * leave requests are seeded as the database owner with the day count the app works out.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

import { addDays, lagosToday } from "../../src/lib/dates";
import { adminClient, anonClient, pgClient } from "../rls/helpers/supabase";
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

const NAV = { timeout: 15_000 };
const CENTRE = "SRID=4326;POINT(3.3611 6.4474)";
const DAY = addDays(lagosToday(), -3);
const at = (time: string) => new Date(`${DAY}T${time}:00+01:00`);

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

function plus(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function nextMonday(today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (8 - dow) + 7);
  return d.toISOString().slice(0, 10);
}

/** Four finished day shifts three days ago: three clocked in and out, one with no clock-out. */
async function seedTimesheets() {
  const admin = adminClient();
  const suffix = uniqueSuffix();
  const owner = await createOwner("lb-ts", `Bulk Guarding ${suffix}`);
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
    { first: "Tunde", last: "Okafor", out: true },
    { first: "Ngozi", last: "Eze", out: false },
  ];
  const lines: Record<string, string> = {};
  const db = await pgClient();
  try {
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
    await db.query(
      `insert into public.contracts (id, organisation_id, client_id, reference, name, type, start_date, vat_applies, status)
       values ($1, $2, $3, $4, 'Guarding', 'manned_post', '2025-01-01', false, 'active')`,
      [contract, org, clientId, `LB-${contract.slice(0, 6)}`],
    );
    await db.query("commit");
    for (const [i, p] of people.entries()) {
      const w = await admin
        .from("workers")
        .insert({
          organisation_id: org,
          staff_id: `LB-${i}-${suffix.slice(0, 4)}`,
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
      await punch("in", at("07:00"));
      if (p.out) await punch("out", at("19:00"));
      lines[`${p.first} ${p.last}`] = assignment;
    }
  } finally {
    await db.end();
  }
  return { owner, assignments: lines };
}

test("tick four timesheet days, approve the three clean ones and skip the flagged one", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-1440", "The 1440px run.");
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { owner, assignments } = await seedTimesheets();

  await signInViaUi(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/app$/, NAV);
  await page.goto(`/app/timesheets?period=${DAY}`);
  await expect(page.getByTestId("timesheet-row")).toHaveCount(4, NAV);

  for (const name of Object.keys(assignments)) {
    await page.getByRole("checkbox", { name: new RegExp(`^Select ${name},`) }).check();
  }
  const bar = page.getByRole("region", { name: "Bulk actions" });
  await expect(bar).toContainText("4 selected");
  await bar.getByRole("button", { name: "Approve selected" }).click();

  const sheet = page.getByRole("dialog", { name: "Approve selected days" });
  await expect(sheet.getByTestId("bulk-summary")).toHaveText(
    /^3 will be approved, 1 skipped: 1 /,
    NAV,
  );
  const skipped = sheet.getByRole("region", { name: "Skipped" });
  await expect(skipped).toContainText("Ngozi Eze");
  await expect(sheet.getByRole("region", { name: "Goes ahead" }).getByRole("listitem")).toHaveCount(
    3,
  );

  await sheet.getByRole("button", { name: "Approve 3 days" }).click();
  await expect(sheet).toBeHidden(NAV);
  await expect(page.getByTestId("list-notice")).toHaveText(/^3 approved, 1 skipped/, NAV);

  const { data } = await adminClient()
    .from("timesheet_lines")
    .select("shift_assignment_id, status")
    .in("shift_assignment_id", Object.values(assignments));
  const status = Object.fromEntries((data ?? []).map((l) => [l.shift_assignment_id, l.status]));
  expect(status[assignments["Musa Bello"]!]).toBe("approved");
  expect(status[assignments["Halima Sani"]!]).toBe("approved");
  expect(status[assignments["Tunde Okafor"]!]).toBe("approved");
  expect(status[assignments["Ngozi Eze"]!]).toBe("pending");
  await expectNoHorizontalScroll(page);
});

test("approve two leave requests together on a phone", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-390", "The 390px run.");
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const today = lagosToday();
  const start = nextMonday(today);
  test.skip(plus(start, 2).slice(0, 4) !== today.slice(0, 4), "Leave across the new year.");

  const admin = adminClient();
  const suffix = uniqueSuffix();
  const owner = await createOwner("lb-leave", `Bulk Leave ${suffix}`);
  const ownerClient = anonClient();
  await ownerClient.auth.signInWithPassword({ email: owner.email, password: owner.password });
  const preset = await ownerClient.rpc("apply_leave_preset", {
    p_organisation_id: owner.orgId,
    p_preset: "B",
  });
  expect(preset.error).toBeNull();
  const annual = (
    await admin.from("leave_types").select("id, code").eq("organisation_id", owner.orgId)
  ).data!.find((t) => t.code === "annual")!.id;

  const people = ["Ada Obi", "Bayo Ade", "Chika Nwosu"];
  const requests: Record<string, string> = {};
  const db = await pgClient();
  try {
    for (const [i, name] of people.entries()) {
      const [first, last] = name.split(" ");
      const w = await admin
        .from("workers")
        .insert({
          organisation_id: owner.orgId,
          staff_id: `LV-${i}-${suffix.slice(0, 4)}`,
          first_name: first!,
          last_name: last!,
          employment_type: "permanent",
          start_date: "2025-01-06",
        })
        .select("id")
        .single();
      expect(w.error).toBeNull();
      const count = await ownerClient.rpc("leave_day_count", {
        p_organisation_id: owner.orgId,
        p_worker_id: w.data!.id,
        p_leave_type_id: annual,
        p_from: start,
        p_to: plus(start, 2),
      });
      expect(count.error).toBeNull();
      const { rows } = await db.query<{ id: string }>(
        `insert into public.leave_requests (organisation_id, worker_id, leave_type_id, leave_year,
           start_date, end_date, days)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [
          owner.orgId,
          w.data!.id,
          annual,
          Number(start.slice(0, 4)),
          start,
          plus(start, 2),
          count.data![0]!.days,
        ],
      );
      requests[name] = rows[0]!.id;
    }
  } finally {
    await db.end();
  }

  await signInViaUi(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/app$/, NAV);
  await page.goto("/app/leave");
  const table = page.getByRole("table", { name: "Leave requests" });
  await expect(table.locator("tbody tr")).toHaveCount(3, NAV);

  await page.getByRole("checkbox", { name: "Select Ada Obi's annual leave" }).check();
  await page.getByRole("checkbox", { name: "Select Bayo Ade's annual leave" }).check();
  const bar = page.getByRole("region", { name: "Bulk actions" });
  await expect(bar).toContainText("2 selected");
  await expectNoHorizontalScroll(page);
  await bar.getByRole("button", { name: "Approve selected" }).click();

  const sheet = page.getByRole("dialog", { name: "Approve selected requests" });
  await expect(sheet.getByTestId("bulk-summary")).toHaveText("2 will be approved.", NAV);
  await sheet.getByRole("button", { name: "Approve 2 requests" }).click();
  await expect(sheet).toBeHidden(NAV);
  await expect(page.getByTestId("list-notice")).toHaveText("2 approved.", NAV);

  const { data } = await admin
    .from("leave_requests")
    .select("id, status")
    .in("id", Object.values(requests));
  const status = Object.fromEntries((data ?? []).map((r) => [r.id, r.status]));
  expect(status[requests["Ada Obi"]!]).toBe("pending_hr");
  expect(status[requests["Bayo Ade"]!]).toBe("pending_hr");
  expect(status[requests["Chika Nwosu"]!]).toBe("pending_line_manager");
});

test("export the selected clients to CSV", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-1440", "One run covers the export.");
  test.setTimeout(90_000);
  const admin = adminClient();
  const suffix = uniqueSuffix();
  const owner = await createOwner("lb-clients", `Export Co ${suffix}`);
  for (const name of [`Coastline ${suffix}`, `Harbour ${suffix}`]) {
    const { error } = await admin.rpc("create_client", {
      p_organisation_id: owner.orgId,
      p_name: name,
      p_contact_name: "Ngozi Eze",
      p_contact_email: `accounts-${randomUUID().slice(0, 6)}@client.example`,
    });
    expect(error).toBeNull();
  }

  await signInViaUi(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/app$/, NAV);
  await page.goto("/app/clients");
  const table = page.getByRole("table", { name: "Clients" });
  await expect(table.locator("tbody tr")).toHaveCount(2, NAV);
  await page.getByRole("checkbox", { name: `Select Coastline ${suffix}` }).check();
  const bar = page.getByRole("region", { name: "Bulk actions" });
  await expect(bar).toContainText("1 selected");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    bar.getByRole("button", { name: "Export CSV" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^clients-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await readFile((await download.path())!, "utf8");
  const rows = csv.replace(/^﻿/, "").split("\r\n").filter(Boolean);
  expect(rows[0]).toBe(
    "Client,Status,Billing details,Sites,Sites without a geofence,Active contracts",
  );
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatch(new RegExp(`^Coastline ${suffix},Active,`));
  expect(csv).not.toContain("@client.example");
  expect(csv).not.toContain(`Harbour ${suffix}`);
  await expect(page.getByTestId("list-notice")).toHaveText("Exported 1 client.", NAV);

  // The export is logged with the count only.
  const { data: audit } = await admin
    .from("audit_log")
    .select("after")
    .eq("organisation_id", owner.orgId)
    .eq("action", "clients.exported");
  expect(audit).toEqual([{ after: { count: 1 } }]);
});

test("the export route is scoped to the caller and refuses other roles and origins", async ({
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-1440", "One run covers the route.");
  test.setTimeout(120_000);
  const baseURL = String(testInfo.project.use.baseURL);
  const admin = adminClient();
  const suffix = uniqueSuffix();
  const owner = await createOwner("lb-route", `Route Co ${suffix}`);
  const ownerClient = anonClient();
  await ownerClient.auth.signInWithPassword({ email: owner.email, password: owner.password });
  const preset = await ownerClient.rpc("apply_leave_preset", {
    p_organisation_id: owner.orgId,
    p_preset: "B",
  });
  expect(preset.error).toBeNull();
  const annual = (
    await admin.from("leave_types").select("id, code").eq("organisation_id", owner.orgId)
  ).data!.find((t) => t.code === "annual")!.id;

  const lm = await createAccount("lb-route-lm", "Kola Adebayo");
  const lmMember = await admin
    .from("memberships")
    .insert({ organisation_id: owner.orgId, user_id: lm.userId, role: "line_manager" })
    .select("id")
    .single();
  expect(lmMember.error).toBeNull();
  const ops = await createAccount("lb-route-ops", "Ngozi Eze");
  await addMembership(owner.orgId, ops.userId, "ops_manager");

  const start = nextMonday(lagosToday());
  const requests: Record<string, string> = {};
  const db = await pgClient();
  try {
    for (const [i, p] of [
      { name: "Ada Reportee", lm: true },
      { name: "Bayo Elsewhere", lm: false },
    ].entries()) {
      const [first, last] = p.name.split(" ");
      const w = await admin
        .from("workers")
        .insert({
          organisation_id: owner.orgId,
          staff_id: `RT-${i}-${suffix.slice(0, 4)}`,
          first_name: first!,
          last_name: last!,
          employment_type: "permanent",
          start_date: "2025-01-06",
          line_manager_membership_id: p.lm ? lmMember.data!.id : null,
        })
        .select("id")
        .single();
      expect(w.error).toBeNull();
      const { rows } = await db.query<{ id: string }>(
        `insert into public.leave_requests (organisation_id, worker_id, leave_type_id, leave_year,
           start_date, end_date, days)
         values ($1, $2, $3, $4, $5, $5, 1) returning id`,
        [owner.orgId, w.data!.id, annual, Number(start.slice(0, 4)), start],
      );
      requests[p.name] = rows[0]!.id;
    }
  } finally {
    await db.end();
  }

  const post = (page: Page, data: unknown, origin = baseURL) =>
    page.request.post("/app/export", {
      headers: { origin, "content-type": "application/json" },
      data,
    });

  // The line manager: their reportee only.
  const lmContext = await browser.newContext({ baseURL });
  const lmPage = await lmContext.newPage();
  await signInViaUi(lmPage, lm.email, lm.password);
  await expect(lmPage).toHaveURL(/\/app/, NAV);
  const mine = await post(lmPage, { list: "leave", ids: [requests["Ada Reportee"]] });
  expect(mine.status()).toBe(200);
  expect(mine.headers()["cache-control"]).toContain("no-store");
  expect(mine.headers()["content-disposition"]).toMatch(/^attachment; filename="leave-/);
  const rows = (await mine.text()).replace(/^﻿/, "").split("\r\n").filter(Boolean);
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatch(/^Ada Reportee,/);
  const notMine = await post(lmPage, { list: "leave", ids: [requests["Bayo Elsewhere"]] });
  expect(notMine.status()).toBe(400);
  expect(await notMine.text()).not.toContain("Bayo");
  // A cross-origin post is refused before anything is read.
  const crossSite = await post(
    lmPage,
    { list: "leave", ids: [requests["Ada Reportee"]] },
    "https://evil.example",
  );
  expect(crossSite.status()).toBe(403);
  await lmContext.close();

  // A role without payroll: 403 on every payroll export.
  const opsContext = await browser.newContext({ baseURL });
  const opsPage = await opsContext.newPage();
  await signInViaUi(opsPage, ops.email, ops.password);
  await expect(opsPage).toHaveURL(/\/app/, NAV);
  for (const data of [
    { list: "payroll_runs", ids: [randomUUID()] },
    { list: "payslips", runId: randomUUID(), ids: [randomUUID()] },
    { list: "remittances", ids: [randomUUID()] },
  ]) {
    expect((await post(opsPage, data)).status(), data.list).toBe(403);
  }
  await opsContext.close();

  // The audit row holds the count only.
  const { data: audit } = await admin
    .from("audit_log")
    .select("after, entity_id")
    .eq("organisation_id", owner.orgId)
    .eq("action", "leave.exported");
  expect(audit).toEqual([{ after: { count: 1 }, entity_id: null }]);
});
