/**
 * Slice 3.8: patrol checkpoint scans, against the production build on a 390px phone with a
 * mocked position.
 * - Visiting /m/checkpoint#<token> as a worker on shift at the site records a checkpoint scan:
 *   "Scanned at", the checkpoint's name, "Sent to your company.", a punch of kind checkpoint.
 *   The token never appears in a URL the browser requests (it lives in the fragment), and it is
 *   taken out of the address bar once read.
 * - Offline, the precached scan page saves the next scan on the phone; back online it syncs.
 * - Another company's code gets the generic refusal; a link with no code asks to scan again;
 *   signed out, the page asks the worker to sign in.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";

import { adminClient, anonClient, pgClient } from "../rls/helpers/supabase";
import { NEEDS_SUPABASE, createOwner, supabaseReady, uniqueSuffix } from "./helpers/auth";

const PIN = "583104";
const CENTRE = { latitude: 6.4474, longitude: 3.3611 };
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

function lagosToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
}

interface Setup {
  workerId: string;
  invite: string;
  gate: string;
  tower: string;
  foreign: string;
}

async function tokenOf(id: string): Promise<string> {
  const db = await pgClient();
  try {
    const { rows } = await db.query<{ qr_token: string }>(
      "select qr_token from public.site_checkpoints where id = $1",
      [id],
    );
    return rows[0]!.qr_token;
  } finally {
    await db.end();
  }
}

/** A company with a site, two checkpoints, a live all-day post and a worker rostered on it. */
async function setUp(label: string): Promise<Setup> {
  const suffix = uniqueSuffix();
  const admin = adminClient();
  const owner = await createOwner(label, `Patrol Co ${suffix}`);
  const ownerClient = anonClient();
  await ownerClient.auth.signInWithPassword({ email: owner.email, password: owner.password });
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
  const points = await admin
    .from("site_checkpoints")
    .insert([
      { organisation_id: owner.orgId, site_id: site.data.id, name: "Gate B" },
      { organisation_id: owner.orgId, site_id: site.data.id, name: "Water tower" },
    ] as never)
    .select("id, name");
  if (points.error) throw new Error(points.error.message);
  const byName = new Map(
    (points.data as { id: string; name: string }[]).map((p) => [p.name, p.id]),
  );

  const worker = await admin
    .from("workers")
    .insert({
      organisation_id: owner.orgId,
      employment_type: "permanent",
      start_date: "2024-03-03",
      staff_id: `PT-${suffix.slice(0, 4)}`,
      first_name: "Peter",
      last_name: "Ade",
    })
    .select("id")
    .single();
  if (worker.error) throw new Error(worker.error.message);
  const map = await admin.from("worker_assignments").insert({
    organisation_id: owner.orgId,
    worker_id: worker.data.id,
    site_id: site.data.id,
    effective_from: "2024-03-03",
  });
  if (map.error) throw new Error(map.error.message);

  // A live contract with an all-day post today, and the worker on it.
  const today = lagosToday();
  const contract = await ownerClient.rpc("create_contract", {
    p_organisation_id: owner.orgId,
    p_contract: {
      client_id: client.data,
      name: "Patrol guarding",
      type: "manned_post",
      start_date: today,
    },
    p_site_ids: [site.data.id],
  });
  if (contract.error) throw new Error(contract.error.message);
  const card = await ownerClient.rpc("save_draft_rate_card", {
    p_organisation_id: owner.orgId,
    p_contract_id: contract.data!,
    p_effective_from: today,
    p_lines: [{ role: "Guard", band: "Day", unit: "shift", rate_kobo: "1250000" }],
  });
  if (card.error) throw new Error(card.error.message);
  const headcount = await ownerClient.from("headcount_requirements").insert({
    organisation_id: owner.orgId,
    contract_id: contract.data!,
    site_id: site.data.id,
    role: "Guard",
    unit: "shift",
    days_of_week: EVERY_DAY,
    required_count: 2,
    post_name: "Patrol",
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
    .eq("name", "Patrol · Day")
    .single();
  if (post.error) throw new Error(post.error.message);
  const assigned = await ownerClient.rpc("assign_worker_to_shift", {
    p_organisation_id: owner.orgId,
    p_post_id: post.data.id,
    p_shift_date: today,
    p_worker_id: worker.data.id,
  });
  if (assigned.error) throw new Error(assigned.error.message);

  const invite = await ownerClient.rpc("create_worker_invites", {
    p_organisation_id: owner.orgId,
    p_worker_ids: [worker.data.id],
    p_sent_via: "print",
  });
  if (invite.error) throw new Error(invite.error.message);

  // Another company's checkpoint, for the refusal.
  const stranger = await createOwner(`${label}-x`, `Elsewhere ${suffix}`);
  const strangerClient = anonClient();
  await strangerClient.auth.signInWithPassword({
    email: stranger.email,
    password: stranger.password,
  });
  const theirClient = await strangerClient.rpc("create_client", {
    p_organisation_id: stranger.orgId,
    p_name: "Elsewhere Ltd",
    p_contact_name: "Ada Obi",
    p_contact_email: `ops-${suffix}@elsewhere.example`,
  });
  if (theirClient.error) throw new Error(theirClient.error.message);
  const theirSite = await admin
    .from("sites")
    .insert({ organisation_id: stranger.orgId, client_id: theirClient.data, name: "Their site" })
    .select("id")
    .single();
  if (theirSite.error) throw new Error(theirSite.error.message);
  const theirPoint = await admin
    .from("site_checkpoints")
    .insert({ organisation_id: stranger.orgId, site_id: theirSite.data.id, name: "Their gate" })
    .select("id")
    .single();
  if (theirPoint.error) throw new Error(theirPoint.error.message);

  return {
    workerId: worker.data.id,
    invite: invite.data![0]!.token,
    gate: await tokenOf(byName.get("Gate B")!),
    tower: await tokenOf(byName.get("Water tower")!),
    foreign: await tokenOf(theirPoint.data.id),
  };
}

async function phone(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    geolocation: { ...CENTRE, accuracy: 10 },
    permissions: ["geolocation"],
  });
  return { context, page: await context.newPage() };
}

/** Sets the PIN from the invite, then agrees to location on the clock screen. */
async function signInAndAgree(page: Page, invite: string, workerId: string) {
  await page.goto(`/m/invite/${invite}`);
  await page.getByLabel("New PIN").fill(PIN);
  await page.getByLabel("Type the PIN again").fill(PIN);
  await page.getByRole("checkbox", { name: /I have read this/ }).check();
  await page.getByRole("button", { name: "Set PIN and sign in" }).click();
  await expect(page).toHaveURL(/\/m$/, { timeout: 15_000 });
  await page.goto("/m/clock");
  await expect(page.getByTestId("clock-consent")).toBeVisible();
  const card = page.getByTestId("consent-location");
  await card.getByRole("button", { name: "I agree" }).click();
  // The clock screen replaces the consent cards once location is agreed: check the record.
  await expect
    .poll(
      async () => {
        const { count } = await adminClient()
          .from("worker_consents")
          .select("id", { count: "exact", head: true })
          .eq("worker_id", workerId)
          .eq("kind", "location")
          .is("withdrawn_at", null);
        return count ?? 0;
      },
      { timeout: 15_000 },
    )
    .toBe(1);
}

async function scansOf(workerId: string) {
  const { data, error } = await adminClient()
    .from("punches")
    .select("id, kind, checkpoint_id, geofence_result, flags")
    .eq("worker_id", workerId)
    .eq("kind", "checkpoint")
    .order("recorded_at");
  if (error) throw new Error(error.message);
  return data;
}

test.describe("checkpoint scan page", () => {
  test.skip(!supabaseReady, NEEDS_SUPABASE);

  test("a link with no code, and a signed-out visit", async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-390", "The worker app is phone-first.");
    const { context, page } = await phone(browser, testInfo.project.use.baseURL);
    await page.goto("/m/checkpoint");
    await expect(page.getByTestId("checkpoint-blocked")).toHaveText(
      "This link has no checkpoint code. Scan the code on the checkpoint again.",
    );
    // A new code on the open page (a hash-only navigation) is read too.
    await page.goto(`/m/checkpoint#${"a".repeat(64)}`);
    await expect(page).toHaveURL(/\/m\/checkpoint$/);
    await expect(page.getByTestId("checkpoint-blocked")).toHaveText(
      "Sign in to the worker app, then scan the checkpoint code again.",
    );
    await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/m/sign-in");
    await context.close();
  });

  test("scans on shift, refuses another company's code, and saves a scan offline", async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-390", "The worker app is phone-first.");
    test.setTimeout(180_000);
    const setup = await setUp("patrol");
    const { context, page } = await phone(browser, testInfo.project.use.baseURL);
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    await signInAndAgree(page, setup.invite, setup.workerId);

    // Online: the scan is recorded and the screen names the checkpoint.
    await page.goto(`/m/checkpoint#${setup.gate}`);
    await expect(page.getByTestId("checkpoint-done")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Scanned at \d\d:\d\d$/);
    await expect(page.getByTestId("checkpoint-status")).toHaveText("Sent to your company.", {
      timeout: 20_000,
    });
    await expect(page.getByTestId("checkpoint-where")).toHaveText("Gate B · Apapa Warehouse 3");
    // The token was read from the fragment and taken out of the address bar.
    await expect(page).toHaveURL(/\/m\/checkpoint$/);
    const [first] = await scansOf(setup.workerId);
    expect(first).toMatchObject({ kind: "checkpoint", geofence_result: "inside" });

    // Another company's code: the generic refusal, nothing recorded.
    await page.goto(`/m/checkpoint#${setup.foreign}`);
    await expect(page.getByTestId("checkpoint-status")).toHaveText(
      "This code isn't a checkpoint you can scan. Tell your supervisor.",
      { timeout: 20_000 },
    );
    expect(await scansOf(setup.workerId)).toHaveLength(1);

    // Offline: the precached scan page saves the scan on the phone.
    await page.goto("/m");
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await context.setOffline(true);
    await page.goto(`/m/checkpoint#${setup.tower}`);
    await expect(page.getByTestId("checkpoint-done")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("checkpoint-status")).toHaveText(
      "Saved on phone. It sends the next time you open the app with network.",
    );
    expect(await scansOf(setup.workerId)).toHaveLength(1);

    // Back online, opening the app sends it.
    await context.setOffline(false);
    await page.goto("/m");
    await expect
      .poll(async () => (await scansOf(setup.workerId)).length, { timeout: 30_000 })
      .toBe(2);

    // The token never travelled in a URL the browser asked for.
    for (const token of [setup.gate, setup.tower, setup.foreign]) {
      expect(requested.filter((url) => url.includes(token))).toEqual([]);
    }
    await context.close();
  });
});
