/**
 * Slice 3.6: crew clock-in by a worker-supervisor, against the production build, on a 390px
 * phone.
 * - The supervisor (the line manager of two workers with no phones, all on today's shift at the
 *   site) opens Clock in crew from home, ticks one person, and marks them present with the
 *   network off: "Saved on phone"; back online it sends. The punch is source supervisor, with the
 *   supervisor's login, and flagged no_selfie: nobody in the crew agreed to photos, so no group
 *   photo is offered.
 * - Then Clock out: only the person clocked in can be ticked.
 */
import { expect, test, type Page } from "@playwright/test";

import type { Json } from "@/types/db";

import { adminClient, anonClient } from "../rls/helpers/supabase";
import { NEEDS_SUPABASE, createOwner, supabaseReady, uniqueSuffix } from "./helpers/auth";

const PIN = "583104";
const CENTRE = { latitude: 6.4474, longitude: 3.3611 };
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

interface Setup {
  orgId: string;
  supervisorId: string;
  crewIds: string[];
  token: string;
}

function lagosToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
}

/** A company with a site, an all-day post today, a supervisor and two crew members on it. */
async function setUp(label: string): Promise<Setup> {
  const suffix = uniqueSuffix();
  const owner = await createOwner(label, `Crew Co ${suffix}`);
  const ownerClient = anonClient();
  await ownerClient.auth.signInWithPassword({ email: owner.email, password: owner.password });
  const admin = adminClient();
  const client = await ownerClient.rpc("create_client", {
    p_organisation_id: owner.orgId,
    p_name: "Coastline Logistics",
    p_contact_name: "Ngozi Eze",
    p_contact_email: `ops-${suffix}@coastline.example`,
  });
  if (client.error) throw new Error(client.error.message);
  const site = await admin
    .from("sites")
    .insert({
      organisation_id: owner.orgId,
      client_id: client.data,
      name: "Apapa Warehouse 3",
      centre: `SRID=4326;POINT(${CENTRE.longitude} ${CENTRE.latitude})`,
      radius_m: 100,
    } as never)
    .select("id")
    .single();
  if (site.error) throw new Error(site.error.message);
  const today = lagosToday();
  const contract = await ownerClient.rpc("create_contract", {
    p_organisation_id: owner.orgId,
    p_contract: {
      client_id: client.data,
      name: "Crew guarding",
      type: "manned_post",
      start_date: today,
    } as Json,
    p_site_ids: [site.data.id],
  });
  if (contract.error) throw new Error(contract.error.message);
  const card = await ownerClient.rpc("save_draft_rate_card", {
    p_organisation_id: owner.orgId,
    p_contract_id: contract.data!,
    p_effective_from: today,
    p_lines: [{ role: "Guard", band: "Day", unit: "shift", rate_kobo: "1250000" }] as Json,
  });
  if (card.error) throw new Error(card.error.message);
  const headcount = await ownerClient.from("headcount_requirements").insert({
    organisation_id: owner.orgId,
    contract_id: contract.data!,
    site_id: site.data.id,
    role: "Guard",
    unit: "shift",
    days_of_week: EVERY_DAY,
    required_count: 3,
    post_name: "Floor crew",
    band: "Day",
    start_time: "00:00",
    end_time: "23:45",
  } as never);
  if (headcount.error) throw new Error(headcount.error.message);
  const live = await ownerClient.rpc("activate_contract", {
    p_organisation_id: owner.orgId,
    p_contract_id: contract.data!,
    p_send_welcome: false,
  });
  if (live.error) throw new Error(live.error.message);
  const post = await admin
    .from("posts")
    .select("id")
    .eq("contract_id", contract.data!)
    .eq("name", "Floor crew · Day")
    .single();
  if (post.error) throw new Error(post.error.message);

  async function addWorker(first: string, last: string, staffId: string, manager?: string) {
    const worker = await admin
      .from("workers")
      .insert({
        organisation_id: owner.orgId,
        employment_type: "permanent",
        start_date: "2024-03-03",
        staff_id: staffId,
        first_name: first,
        last_name: last,
        ...(manager ? { line_manager_worker_id: manager, supervisor_clock_in: true } : {}),
      })
      .select("id")
      .single();
    if (worker.error) throw new Error(worker.error.message);
    const assigned = await ownerClient.rpc("assign_worker_to_shift", {
      p_organisation_id: owner.orgId,
      p_post_id: post.data!.id,
      p_shift_date: today,
      p_worker_id: worker.data.id,
    });
    if (assigned.error) throw new Error(assigned.error.message);
    return worker.data.id;
  }

  const tag = suffix.slice(0, 4);
  const supervisorId = await addWorker("Kola", "Adebayo", `SV-${tag}`);
  const crewIds = [
    await addWorker("Grace", "Okon", `CA-${tag}`, supervisorId),
    await addWorker("Sani", "Garba", `CB-${tag}`, supervisorId),
  ];
  const invite = await ownerClient.rpc("create_worker_invites", {
    p_organisation_id: owner.orgId,
    p_worker_ids: [supervisorId],
    p_sent_via: "print",
  });
  if (invite.error) throw new Error(invite.error.message);
  return { orgId: owner.orgId, supervisorId, crewIds, token: invite.data![0]!.token };
}

async function signIn(page: Page, token: string) {
  await page.goto(`/m/invite/${token}`);
  await page.getByLabel("New PIN").fill(PIN);
  await page.getByLabel("Type the PIN again").fill(PIN);
  await page.getByRole("checkbox", { name: /I have read this/ }).check();
  await page.getByRole("button", { name: "Set PIN and sign in" }).click();
  await expect(page).toHaveURL(/\/m$/, { timeout: 15_000 });
}

async function punchesOf(workerIds: string[]) {
  const { data, error } = await adminClient()
    .from("punches")
    .select("worker_id, kind, source, flags, crew_batch_id")
    .in("worker_id", workerIds)
    .order("recorded_at");
  if (error) throw new Error(error.message);
  return data;
}

test.describe("crew clock-in", () => {
  test.skip(!supabaseReady, NEEDS_SUPABASE);

  test("a supervisor marks one person present offline, then clocks them out", async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-390", "The worker app is phone-first.");
    test.setTimeout(150_000);
    const setup = await setUp("crew");
    const context = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    await signIn(page, setup.token);

    const card = page.getByTestId("crew-card");
    await expect(card).toContainText("2 people in your crew");
    await card.click();
    await expect(page).toHaveURL(/\/m\/crew$/);
    await expect(page.getByTestId("crew-title")).toHaveText("Clock in crew");
    await expect(
      page.getByText(/^Floor crew · Day · \d\d:\d\d–\d\d:\d\d · Apapa Warehouse 3$/),
    ).toBeVisible();
    await expect(page.getByTestId("crew-count")).toHaveText("0 of 2 present");
    // Nobody fits wider than the phone.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );

    await page.getByRole("checkbox", { name: "Mark Grace Okon present" }).check();
    await expect(page.getByTestId("crew-count")).toHaveText("1 of 2 present");
    await expect(page.getByTestId("crew-photo-blocked")).toHaveText(
      "No group photo: 1 person here hasn't agreed to photos.",
    );

    await context.setOffline(true);
    await expect(page.getByTestId("offline-banner")).toBeVisible();
    await page.getByRole("button", { name: "Mark 1 present" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^1 clocked in at \d\d:\d\d$/);
    await expect(page.getByTestId("crew-send-status")).toHaveText(
      "Saved on phone. Will send when network returns.",
    );
    await expect(page.getByTestId("crew-photo-note")).toHaveText(
      "No group photo, so these punches are flagged for review",
    );
    await expect(page.getByText("Not marked: Sani")).toBeVisible();
    expect(await punchesOf(setup.crewIds)).toEqual([]);

    await context.setOffline(false);
    await expect(page.getByTestId("crew-send-status")).toHaveText("Sent to your company.", {
      timeout: 30_000,
    });
    const [punch] = await punchesOf(setup.crewIds);
    expect(punch).toMatchObject({ worker_id: setup.crewIds[0], kind: "in", source: "supervisor" });
    expect(punch!.crew_batch_id).not.toBeNull();
    expect(punch!.flags).toEqual(expect.arrayContaining(["no_selfie", "no_location"]));

    // Clock out: only Grace is clocked in.
    await page.getByRole("button", { name: "Back to crew" }).click();
    await page.getByRole("tab", { name: "Clock out" }).click();
    await expect(page.getByTestId("crew-title")).toHaveText("Clock out crew");
    await expect(
      page.getByRole("checkbox", { name: "Mark Sani Garba clocked out" }),
    ).toBeDisabled();
    await page.getByRole("checkbox", { name: "Mark Grace Okon clocked out" }).check();
    await page.getByRole("button", { name: "Mark 1 clocked out" }).click();
    await expect(page.getByTestId("crew-send-status")).toHaveText("Sent to your company.", {
      timeout: 30_000,
    });
    const punches = await punchesOf(setup.crewIds);
    expect(punches.map((p) => p.kind)).toEqual(["in", "out"]);
    expect(punches[1]!.flags).not.toContain("out_without_in");
    await context.close();
  });
});
