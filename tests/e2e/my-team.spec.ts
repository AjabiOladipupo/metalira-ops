/**
 * Slice 4.7: a line manager works from My team: assigns their reportee to an open shift at their
 * site, approves step 1 of a leave request (seeing the shifts it opens), and raises a query, at
 * 1440px and 390px.
 */
import { expect, test, type Page } from "@playwright/test";

import { addDays, lagosToday } from "../../src/lib/dates";
import { isoWeekday } from "../../src/lib/headcount";
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
 * A live contract at Apapa Warehouse 3 (Gate A · Day, one guard every day), HR, a line manager,
 * annual leave from preset B, and Musa (the line manager's reportee) on Gate A · Day Tuesday to
 * Thursday of next week, asking for those three days off.
 */
async function seed() {
  const admin = adminClient();
  const suffix = uniqueSuffix();
  const owner = await createOwner("mt-owner", `Kola Guarding ${suffix}`);
  const org = owner.orgId;
  const ops = await createAccount("mt-ops", "Obinna Okafor");
  await addMembership(org, ops.userId, "ops_manager");
  const hr = await createAccount("mt-hr", "Ngozi Eze");
  await addMembership(org, hr.userId, "hr");
  const lm = await createAccount("mt-lm", "Kola Adebayo");
  await addMembership(org, lm.userId, "line_manager");
  const lmMembership = await admin
    .from("memberships")
    .select("id")
    .eq("organisation_id", org)
    .eq("user_id", lm.userId)
    .single();
  if (lmMembership.error) throw new Error(lmMembership.error.message);

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
      line_manager_membership_id: lmMembership.data.id,
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

  // Musa on Gate A · Day, Tuesday to Thursday, through the guard (secret key). The other days
  // stay open for the line manager to fill.
  for (const date of leaveDays) {
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

  return { org, lm, requestId };
}

for (const width of [1440, 390] as const) {
  test(`a line manager assigns, approves leave and raises a query from My team at ${width}px`, async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-390", "One run covers both widths.");
    test.skip(
      leaveDays[2]!.slice(0, 4) !== today.slice(0, 4),
      "Leave across the new year is two requests.",
    );
    test.setTimeout(240_000);
    const s = await seed();
    const context = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      viewport: { width, height: width === 390 ? 844 : 1000 },
    });
    const page = await context.newPage();
    await signInViaUi(page, s.lm.email, s.lm.password);
    await expect(page).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });

    // Reportees: one person, with Assign shift.
    await page.goto("/app/team");
    await expect(page.getByRole("heading", { name: "1 person reports to you" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByRole("link", { name: "Assign a shift to Musa Ibrahim" }).click();
    const panel = page.getByTestId("team-assign-panel");
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Assign", exact: true }).click();
    await expect(panel.getByRole("status")).toContainText("Musa Ibrahim assigned", {
      timeout: 15_000,
    });

    // Leave requests: step 1 with the shifts it opens, then Approve.
    await page.goto("/app/team?tab=leave");
    const request = page.getByTestId("team-leave-request");
    await expect(request).toHaveCount(1);
    await expect(request.getByTestId("team-leave-opens")).toContainText(
      "Opens 3 shifts: Gate A · Day,",
    );
    await expectNoHorizontalScroll(page);
    await request.getByRole("button", { name: "Approve, send to HR" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Approved · sent to HR" }),
    ).toBeVisible({ timeout: 15_000 });

    // Queries: New query for Musa with a reply-by date.
    await page.goto("/app/team?tab=queries");
    const form = page.getByRole("form", { name: "New query" });
    await form.getByLabel("Subject").fill("Lateness on Monday");
    await form.getByLabel("What happened").fill("You clocked in at 06:40 for the 06:00 shift.");
    await form.getByRole("button", { name: "Send query" }).click();
    await expect(page.getByText(/Query sent\. Reply needed by/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("hr-query")).toHaveCount(1);
    await expectNoHorizontalScroll(page);
    await context.close();
  });
}
