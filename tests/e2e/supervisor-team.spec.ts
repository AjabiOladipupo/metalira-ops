/**
 * Slice 4.7b: a worker-supervisor opens My team from the Approvals row on the worker home, at
 * 390px, approves a crew member's timesheet day and step 1 of their leave. HR decides next.
 */
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { adminClient, anonClient, pgClient } from "../rls/helpers/supabase";
import { NEEDS_SUPABASE, createOwner, supabaseReady, uniqueSuffix } from "./helpers/auth";

test.skip(!supabaseReady, NEEDS_SUPABASE);

const PIN = "482913";
const PIN_HASH = `s1$k1$${"A".repeat(22)}$${"B".repeat(43)}`;
const CENTRE = "SRID=4326;POINT(3.3611 6.4474)";

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
  d.setUTCDate(d.getUTCDate() + (8 - dow));
  return d.toISOString().slice(0, 10);
}

async function setup(today: string) {
  const suffix = uniqueSuffix();
  const owner = await createOwner("sup-team", `Supervisor Co ${suffix}`);
  const admin = adminClient();
  const ownerClient = anonClient();
  await ownerClient.auth.signInWithPassword({ email: owner.email, password: owner.password });
  const preset = await ownerClient.rpc("apply_leave_preset", {
    p_organisation_id: owner.orgId,
    p_preset: "B",
  });
  if (preset.error) throw new Error(preset.error.message);

  const addWorker = async (first: string, last: string, lineManager: string | null) => {
    const { data, error } = await admin
      .from("workers")
      .insert({
        organisation_id: owner.orgId,
        employment_type: "permanent",
        start_date: "2024-03-03",
        staff_id: `SP-${randomUUID().slice(0, 6)}`,
        first_name: first,
        last_name: last,
        line_manager_worker_id: lineManager,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id;
  };
  const supervisor = await addWorker("Kola", "Adebayo", null);
  const crew = await addWorker("Musa", "Ibrahim", supervisor);
  const invites = await ownerClient.rpc("create_worker_invites", {
    p_organisation_id: owner.orgId,
    p_worker_ids: [supervisor, crew],
    p_sent_via: "print",
  });
  if (invites.error) throw new Error(invites.error.message);
  const tokenOf = (id: string) => invites.data!.find((i) => i.invite_worker_id === id)!.token;

  // The crew member's own session, opened the way the server does it, to ask for leave.
  const email = `w-${crew}@workers.metalira.invalid`;
  const login = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    app_metadata: { login: "worker" },
  });
  if (login.error) throw new Error(login.error.message);
  const accepted = await admin.rpc("accept_worker_invite", {
    p_token: tokenOf(crew),
    p_auth_user_id: login.data.user!.id,
    p_pin_hash: PIN_HASH,
  });
  if (accepted.error) throw new Error(accepted.error.message);
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (link.error) throw new Error(link.error.message);
  const crewClient = anonClient();
  const verified = await crewClient.auth.verifyOtp({
    type: "email",
    token_hash: link.data.properties!.hashed_token,
  });
  if (verified.error) throw new Error(verified.error.message);
  const types = await admin.from("leave_types").select("id, code").eq("organisation_id", owner.orgId);
  const annual = types.data!.find((t) => t.code === "annual")!.id;
  const start = nextMonday(today);
  const leave = await crewClient.rpc("request_leave", {
    p_organisation_id: owner.orgId,
    p_leave_type_id: annual,
    p_start_date: start,
    p_end_date: plus(start, 2),
  });
  if (leave.error) throw new Error(leave.error.message);

  // A finished day for the crew member, two days ago, clocked in and out on time.
  const { data: clientId, error: clientError } = await admin.rpc("create_client", {
    p_organisation_id: owner.orgId,
    p_name: "Coastline Logistics",
    p_contact_name: "Ngozi Eze",
    p_contact_email: "accounts@coastline.example",
  });
  if (clientError) throw new Error(clientError.message);
  const site = await admin
    .from("sites")
    .insert({
      organisation_id: owner.orgId,
      client_id: clientId!,
      name: "Apapa Warehouse 3",
      centre: CENTRE,
    } as never)
    .select("id")
    .single();
  if (site.error) throw new Error(site.error.message);
  const day = plus(today, -2);
  const startsAt = new Date(`${day}T07:00:00+01:00`);
  const endsAt = new Date(`${day}T19:00:00+01:00`);
  const [contract, post, shift, assignment] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const db = await pgClient();
  try {
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
    await db.query(
      `insert into public.contracts (id, organisation_id, client_id, reference, name, type, start_date, vat_applies, status)
       values ($1, $2, $3, $4, 'Guarding', 'manned_post', '2025-01-01', false, 'active')`,
      [contract, owner.orgId, clientId, `SP-${contract.slice(0, 8)}`],
    );
    await db.query(
      `insert into public.posts (id, organisation_id, contract_id, site_id, name, role, band, unit, opened_on)
       values ($1, $2, $3, $4, 'Gate A · Day', 'Guard', 'Day', 'shift', $5)`,
      [post, owner.orgId, contract, site.data.id, day],
    );
    await db.query(
      `insert into public.shifts (id, organisation_id, post_id, contract_id, site_id, shift_date, starts_at, ends_at, required_count)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 1)`,
      [shift, owner.orgId, post, contract, site.data.id, day, startsAt, endsAt],
    );
    await db.query(
      `insert into public.shift_assignments (id, organisation_id, shift_id, site_id, shift_date, worker_id, starts_at, ends_at, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'assigned')`,
      [assignment, owner.orgId, shift, site.data.id, day, crew, startsAt, endsAt],
    );
    for (const [kind, when] of [
      ["in", startsAt],
      ["out", endsAt],
    ] as const) {
      await db.query(
        `insert into public.punches (id, organisation_id, worker_id, kind, source, recorded_by_user, client_event_id,
           shift_assignment_id, site_id, device_time, received_at, recorded_at, time_source,
           clock_drift_seconds, geofence_result, flags, payload_hash, created_at)
         values ($1, $2, $3, $4, 'self', $5, $6, $7, $8, $9, $9, $9, 'elapsed', 0, 'inside', '{}',
           md5(gen_random_uuid()::text), $9)`,
        [randomUUID(), owner.orgId, crew, kind, randomUUID(), randomUUID(), assignment, site.data.id, when],
      );
    }
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    await db.end();
  }
  const refreshed = await ownerClient.rpc("refresh_timesheet_lines", {
    p_organisation_id: owner.orgId,
    p_from: day,
    p_to: day,
  });
  if (refreshed.error) throw new Error(refreshed.error.message);
  return { supervisorToken: tokenOf(supervisor), start };
}

test("a supervisor approves a crew day and a leave step 1 from My team at 390px", async ({
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-390", "A phone screen.");
  test.setTimeout(240_000);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
  test.skip(
    plus(nextMonday(today), 2).slice(0, 4) !== today.slice(0, 4),
    "Leave across the new year is two requests.",
  );
  const s = await setup(today);

  const phone = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: { width: 390, height: 844 },
  });
  const page = await phone.newPage();
  await page.goto(`/m/invite/${s.supervisorToken}`);
  await page.getByLabel("New PIN").fill(PIN);
  await page.getByLabel("Type the PIN again").fill(PIN);
  await page.getByRole("checkbox", { name: /I have read this/ }).check();
  await page.getByRole("button", { name: "Set PIN and sign in" }).click();
  await expect(page).toHaveURL(/\/m$/, { timeout: 15_000 });

  // The Approvals row: 1 day and 1 leave request.
  await expect(page.getByTestId("approvals-count")).toContainText("2");
  await page.getByTestId("approvals-row").click();
  await expect(page).toHaveURL(/\/m\/team$/);
  await expect(page.getByRole("heading", { level: 1, name: "My team" })).toBeVisible();
  await expect(page.getByTestId("team-count")).toHaveText("2 to approve");
  await expectNoHorizontalScroll(page);

  const day = page.getByTestId("crew-day").first();
  await expect(day).toContainText("Musa Ibrahim");
  await expect(day).toContainText("12 h");
  await day.getByRole("button", { name: "Approve" }).click();
  await expect(day.getByTestId("crew-day-done")).toContainText("Approved");

  const leave = page.getByTestId("crew-leave").first();
  await expect(leave).toContainText("Musa Ibrahim");
  await expect(leave).toContainText("3 working days");
  await expect(leave.getByTestId("crew-leave-balance")).toContainText("15 days left");
  await leave.getByRole("button", { name: "Approve" }).click();
  await expect(leave.getByTestId("crew-leave-done")).toContainText("sent to HR");

  await page.reload();
  await expect(page.getByTestId("team-count")).toHaveText("Nothing to approve");
  await expect(page.getByTestId("team-days-empty")).toBeVisible();
  await expect(page.getByTestId("team-leave-empty")).toBeVisible();
  await expectNoHorizontalScroll(page);
});
