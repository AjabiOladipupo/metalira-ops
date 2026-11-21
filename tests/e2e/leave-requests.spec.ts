/**
 * Slice 4.4: a worker asks for 3 working days on the phone and sees them counted; the line
 * manager approves step 1 and HR approves step 2 from /app/leave; the worker's annual balance
 * drops by 3 only after HR's approval. The Leave board works at 390px and 1440px.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient, anonClient } from "../rls/helpers/supabase";
import {
  NEEDS_SUPABASE,
  createAccount,
  createOwner,
  signInViaUi,
  supabaseReady,
  uniqueSuffix,
} from "./helpers/auth";

test.skip(!supabaseReady, NEEDS_SUPABASE);

const PIN = "482913";

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

function nextMonday(today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (8 - dow) + 7);
  return d.toISOString().slice(0, 10);
}

function plus(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function setup() {
  const suffix = uniqueSuffix();
  const owner = await createOwner("leave-req", `Leave Co ${suffix}`);
  const admin = adminClient();
  const ownerClient = anonClient();
  await ownerClient.auth.signInWithPassword({ email: owner.email, password: owner.password });
  const preset = await ownerClient.rpc("apply_leave_preset", {
    p_organisation_id: owner.orgId,
    p_preset: "B",
  });
  if (preset.error) throw new Error(preset.error.message);

  const lm = await createAccount("leave-lm", "Kola Adebayo");
  const lmMember = await admin
    .from("memberships")
    .insert({ organisation_id: owner.orgId, user_id: lm.userId, role: "line_manager" })
    .select("id")
    .single();
  if (lmMember.error) throw new Error(lmMember.error.message);
  const hr = await createAccount("leave-hr", "Ngozi Eze");
  const hrMember = await admin
    .from("memberships")
    .insert({ organisation_id: owner.orgId, user_id: hr.userId, role: "hr" });
  if (hrMember.error) throw new Error(hrMember.error.message);

  const worker = await admin
    .from("workers")
    .insert({
      organisation_id: owner.orgId,
      employment_type: "permanent",
      start_date: "2024-03-03",
      staff_id: `LV-${suffix.slice(0, 4)}`,
      first_name: "Musa",
      last_name: "Ibrahim",
      line_manager_membership_id: lmMember.data.id,
    })
    .select("id")
    .single();
  if (worker.error) throw new Error(worker.error.message);
  const invite = await ownerClient.rpc("create_worker_invites", {
    p_organisation_id: owner.orgId,
    p_worker_ids: [worker.data.id],
    p_sent_via: "print",
  });
  if (invite.error) throw new Error(invite.error.message);
  return { orgId: owner.orgId, token: invite.data![0]!.token, lm, hr };
}

test("a worker asks for 3 days; line manager then HR approve; the balance drops by 3", async ({
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-390", "One run covers both widths.");
  test.setTimeout(240_000);
  const lagosToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
  const start = nextMonday(lagosToday);
  const end = plus(start, 2);
  test.skip(end.slice(0, 4) !== lagosToday.slice(0, 4), "Leave across the new year is two requests.");
  const s = await setup();

  // The worker, on the phone.
  const phone = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: { width: 390, height: 844 },
  });
  const w = await phone.newPage();
  await w.goto(`/m/invite/${s.token}`);
  await w.getByLabel("New PIN").fill(PIN);
  await w.getByLabel("Type the PIN again").fill(PIN);
  await w.getByRole("checkbox", { name: /I have read this/ }).check();
  await w.getByRole("button", { name: "Set PIN and sign in" }).click();
  await expect(w).toHaveURL(/\/m$/, { timeout: 15_000 });

  await w.goto("/m/leave");
  await expect(w.getByTestId("balance-annual")).toContainText("15");
  await w.getByRole("button", { name: "Annual", exact: true }).click();
  await w.getByLabel("From").fill(start);
  await w.getByLabel("To").fill(end);
  await expect(w.getByTestId("leave-count")).toContainText("3 working days.");
  await expectNoHorizontalScroll(w);
  await w.getByLabel("Reason (optional)").fill("Family visit");
  await w.getByRole("button", { name: "Send request" }).click();
  await expect(w.getByTestId("leave-sent")).toContainText("Line manager: Kola Adebayo");
  await w.reload();
  // Asked, not yet approved: the tile shows the 12 left after the 3 waiting.
  await expect(w.getByTestId("my-leave-request")).toContainText("With line manager");
  await expect(w.getByTestId("balance-annual")).toContainText("12");

  // The line manager, at 1440.
  const desk = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: { width: 1440, height: 1000 },
  });
  const m = await desk.newPage();
  await signInViaUi(m, s.lm.email, s.lm.password);
  await expect(m).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });
  await m.goto("/app/leave");
  await expect(m.getByRole("heading", { level: 1, name: "Leave" })).toBeVisible();
  await m.getByRole("link", { name: /Open Musa Ibrahim's annual leave/ }).click();
  await expect(m.getByTestId("leave-recount")).toContainText("3 working days");
  await m.getByRole("button", { name: "Approve, send to HR" }).click();
  await expect(m.getByText("Approved · sent to HR")).toBeVisible();
  await desk.close();

  // HR, at 390 on the manager app.
  const hrPhone = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: { width: 390, height: 844 },
  });
  const h = await hrPhone.newPage();
  await signInViaUi(h, s.hr.email, s.hr.password);
  await expect(h).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });
  await h.goto("/app/leave");
  await expectNoHorizontalScroll(h);
  await h.getByRole("link", { name: /Open Musa Ibrahim's annual leave/ }).click();
  await expect(h.getByTestId("hr-preview")).toContainText("the balance goes from 15 to 12");
  await h.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(h.getByText(/Approved · 3 days off the balance, 12 left/)).toBeVisible();
  await expectNoHorizontalScroll(h);
  await hrPhone.close();

  // The worker sees it approved and 12 days left.
  await w.reload();
  await expect(w.getByTestId("balance-annual")).toContainText("12");
  await expect(w.getByTestId("my-past-leave").first()).toContainText("Approved");
  await phone.close();
});
