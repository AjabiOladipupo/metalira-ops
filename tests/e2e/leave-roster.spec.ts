/**
 * Slice 4.5: HR approves 3 days of leave and the worker's 3 shifts appear in the roster's
 * Uncovered tray, with an "On leave" chip where the worker was (the BUILD_PLAN "done when"). HR
 * decides at 390px; ops reads the roster at 1440px and at 390px (one day at a time).
 */
import { expect, test, type Page } from "@playwright/test";

import { addDays, lagosToday } from "../../src/lib/dates";
import { isoWeekday } from "../../src/lib/headcount";
import { formatShortDay } from "../../src/lib/roster";
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
const PIN_HASH = `s1$k1$${"A".repeat(22)}$${"B".repeat(43)}`;
const today = lagosToday();
/** Next Monday (never today). */
const weekOne = addDays(today, 8 - isoWeekday(today));
const leaveDays = [addDays(weekOne, 1), addDays(weekOne, 2), addDays(weekOne, 3)];

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/**
 * A live contract at Apapa Warehouse 3 (Gate A · Day 06:00–18:00, one guard every day), an ops
 * manager, HR, annual leave from preset B, and Musa on Gate A · Day Monday to Friday of next week.
 */
async function seed() {
  const admin = adminClient();
  const suffix = uniqueSuffix();
  const owner = await createOwner("lr-owner", `Kola Guarding ${suffix}`);
  const org = owner.orgId;
  const ops = await createAccount("lr-ops", "Obinna Okafor");
  await addMembership(org, ops.userId, "ops_manager");
  const hr = await createAccount("lr-hr", "Ngozi Eze");
  await addMembership(org, hr.userId, "hr");

  const ownerClient = anonClient();
  await ownerClient.auth.signInWithPassword({ email: owner.email, password: owner.password });
  const preset = await ownerClient.rpc("apply_leave_preset", {
    p_organisation_id: org,
    p_preset: "B",
  });
  if (preset.error) throw new Error(preset.error.message);
  const annual = await admin
    .from("leave_types")
    .select("id")
    .eq("organisation_id", org)
    .eq("code", "annual")
    .single();
  if (annual.error) throw new Error(annual.error.message);

  const { data: clientId, error } = await admin.rpc("create_client", {
    p_organisation_id: org,
    p_name: "Coastline Logistics",
    p_contact_name: "Ngozi Eze",
    p_contact_email: "accounts@coastline.example",
  });
  if (error) throw new Error(error.message);
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
  if (site.error) throw new Error(site.error.message);
  const apapa = site.data.id;
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
  if (contract.error) throw new Error(contract.error.message);
  const contractId = contract.data.id;
  const link = await admin
    .from("contract_sites")
    .insert({ organisation_id: org, contract_id: contractId, site_id: apapa });
  if (link.error) throw new Error(link.error.message);
  const live = await admin
    .from("contracts")
    .update({
      status: "active",
      go_live_date: today,
      activated_at: new Date().toISOString(),
    } as never)
    .eq("id", contractId);
  if (live.error) throw new Error(live.error.message);
  const post = await admin
    .from("posts")
    .insert({
      organisation_id: org,
      contract_id: contractId,
      site_id: apapa,
      name: "Gate A · Day",
      role: "Guard",
      band: "Day",
      unit: "shift",
      opened_on: today,
    })
    .select("id")
    .single();
  if (post.error) throw new Error(post.error.message);
  const req = await admin.from("roster_requirements").insert({
    organisation_id: org,
    post_id: post.data.id,
    contract_id: contractId,
    site_id: apapa,
    effective_from: today,
    days_of_week: [1, 2, 3, 4, 5, 6, 7],
    start_time: "06:00",
    end_time: "18:00",
    required_count: 1,
  });
  if (req.error) throw new Error(req.error.message);

  const worker = await admin
    .from("workers")
    .insert({
      organisation_id: org,
      staff_id: `EMP-${suffix.slice(0, 4)}`,
      first_name: "Musa",
      last_name: "Ibrahim",
      employment_type: "permanent",
      start_date: "2025-01-06",
    })
    .select("id")
    .single();
  if (worker.error) throw new Error(worker.error.message);
  const musa = worker.data.id;
  const map = await admin
    .from("worker_assignments")
    .insert({
      organisation_id: org,
      worker_id: musa,
      site_id: apapa,
      effective_from: "2025-01-06",
    });
  if (map.error) throw new Error(map.error.message);

  // Musa on Gate A · Day, Monday to Friday, through the guard (secret key).
  for (let n = 0; n < 5; n += 1) {
    const date = addDays(weekOne, n);
    const shift = await admin
      .from("shifts")
      .insert({
        organisation_id: org,
        post_id: post.data.id,
        contract_id: contractId,
        site_id: apapa,
        shift_date: date,
        starts_at: new Date().toISOString(),
        ends_at: new Date(Date.now() + 60_000).toISOString(),
        required_count: 1,
      })
      .select("id")
      .single();
    if (shift.error) throw new Error(shift.error.message);
    const row = await admin.from("shift_assignments").insert({
      organisation_id: org,
      shift_id: shift.data.id,
      site_id: apapa,
      shift_date: date,
      worker_id: musa,
      starts_at: new Date().toISOString(),
      ends_at: new Date(Date.now() + 60_000).toISOString(),
    });
    if (row.error) throw new Error(row.error.message);
  }

  // Musa asks for Tuesday to Thursday from the phone (a worker session, as the server opens it).
  const invite = await ownerClient.rpc("create_worker_invites", {
    p_organisation_id: org,
    p_worker_ids: [musa],
    p_sent_via: "print",
  });
  if (invite.error) throw new Error(invite.error.message);
  const email = `w-${musa}@workers.metalira.invalid`;
  const login = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    app_metadata: { login: "worker" },
  });
  if (login.error) throw new Error(login.error.message);
  const accepted = await admin.rpc("accept_worker_invite", {
    p_token: invite.data![0]!.token,
    p_auth_user_id: login.data.user!.id,
    p_pin_hash: PIN_HASH,
  });
  if (accepted.error) throw new Error(accepted.error.message);
  const magic = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (magic.error) throw new Error(magic.error.message);
  const phone = anonClient();
  const verified = await phone.auth.verifyOtp({
    type: "email",
    token_hash: magic.data.properties!.hashed_token,
  });
  if (verified.error) throw new Error(verified.error.message);
  const asked = await phone.rpc("request_leave", {
    p_organisation_id: org,
    p_leave_type_id: annual.data.id,
    p_start_date: leaveDays[0]!,
    p_end_date: leaveDays[2]!,
  });
  if (asked.error) throw new Error(asked.error.message);
  const requestId = (asked.data as { id: string }).id;

  // Musa has no line manager: the ops manager decides step 1.
  const opsClient = anonClient();
  await opsClient.auth.signInWithPassword({ email: ops.email, password: ops.password });
  const step1 = await opsClient.rpc("decide_leave_line_manager", {
    p_organisation_id: org,
    p_request_id: requestId,
    p_decision: "approved",
  });
  if (step1.error) throw new Error(step1.error.message);
  return { org, apapa, ops, hr, requestId };
}

test("HR approves 3 days of leave and the 3 shifts appear in the Uncovered tray", async ({
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-390", "One run covers both widths.");
  test.skip(
    leaveDays[2]!.slice(0, 4) !== today.slice(0, 4),
    "Leave across the new year is two requests.",
  );
  test.setTimeout(240_000);
  const s = await seed();
  const rosterPath = `/app/roster?site=${s.apapa}&week=${weekOne}`;

  // Ops at 1440, before: Musa is on the three days, so they aren't in the tray.
  const desk = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: { width: 1440, height: 1000 },
  });
  const o = await desk.newPage();
  await signInViaUi(o, s.ops.email, s.ops.password);
  await expect(o).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });
  await o.goto(rosterPath);
  const tray = o.getByTestId("uncovered-tray");
  await expect(tray).toBeVisible();
  for (const date of leaveDays) {
    await expect(
      tray.getByTestId("tray-card").filter({ hasText: formatShortDay(date) }),
    ).toHaveCount(0);
  }

  // HR at 390: the preview lists the shifts, then Approve.
  const hrPhone = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: { width: 390, height: 844 },
  });
  const h = await hrPhone.newPage();
  await signInViaUi(h, s.hr.email, s.hr.password);
  await expect(h).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });
  await h.goto(`/app/leave/${s.requestId}`);
  await expect(h.getByTestId("hr-preview")).toContainText("Opens 3 shifts: Gate A · Day,");
  await expectNoHorizontalScroll(h);
  await h.getByRole("button", { name: "Approve", exact: true }).click();
  // The decision form leaves the page once the request is decided (it revalidates), so check the
  // HR step line rather than the form's message.
  await expect(h.getByText(/Approved by Ngozi Eze/)).toBeVisible({ timeout: 15_000 });
  await hrPhone.close();

  // Ops again: the three days are in the tray, with the On leave chip on the grid.
  await o.goto(rosterPath);
  for (const date of leaveDays) {
    const card = tray.getByTestId("tray-card").filter({ hasText: formatShortDay(date) });
    await expect(card).toHaveCount(1);
    // Musa is the only guard and he is on leave: nobody to suggest.
    await expect(card).toContainText("No one is free for this shift.");
  }
  await expect(o.getByTestId("roster-grid").getByTestId("on-leave-chip")).toHaveCount(3);
  await expect(o.getByTestId("roster-grid").getByTestId("on-leave-chip").first()).toContainText(
    "On leave",
  );
  await expectNoHorizontalScroll(o);
  await desk.close();

  // Ops at 390: one day at a time shows the chip on Tuesday.
  const opsPhone = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: { width: 390, height: 844 },
  });
  const p = await opsPhone.newPage();
  await signInViaUi(p, s.ops.email, s.ops.password);
  await expect(p).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });
  await p.goto(rosterPath);
  await p.getByTestId("roster-day-view").getByRole("tab").nth(1).click();
  await expect(p.getByTestId("roster-day-view").getByTestId("on-leave-chip")).toHaveCount(1);
  await expectNoHorizontalScroll(p);
  await opsPhone.close();
});
