/**
 * Slice 3.5: clock in from the worker app, against the production build, on a 390px phone with
 * a mocked position and Chromium's fake camera.
 * - Inside the site: consent first, the distance, the selfie, "Clocked in at", sent; the punch
 *   is recorded inside with its selfie.
 * - Outside the site with a reason: "Sent for review…", recorded with the outside flag.
 * - THE PHASE 3 DONE-WHEN: offline, with the phone's clock 10 minutes fast, a clock-in outside
 *   the site is "Saved on phone"; back online it syncs, its recorded_at is the real time (not the
 *   phone's), it carries clock_drift, and it arrives flagged outside.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { adminClient, anonClient } from "../rls/helpers/supabase";
import { NEEDS_SUPABASE, createOwner, supabaseReady, uniqueSuffix } from "./helpers/auth";

const PIN = "583104";
const CENTRE = { latitude: 6.4474, longitude: 3.3611 };
const north = (m: number) => ({
  latitude: CENTRE.latitude + m / 111_195,
  longitude: CENTRE.longitude,
});
const SKEW_MS = 10 * 60_000;

test.use({
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});

interface Setup {
  orgId: string;
  workerId: string;
  token: string;
}

/** A company with a site (100 m around CENTRE) and a worker mapped to it, invited. */
async function setUp(label: string): Promise<Setup> {
  const suffix = uniqueSuffix();
  const owner = await createOwner(label, `Clock Co ${suffix}`);
  const ownerClient = anonClient();
  await ownerClient.auth.signInWithPassword({ email: owner.email, password: owner.password });
  const client = await ownerClient.rpc("create_client", {
    p_organisation_id: owner.orgId,
    p_name: "Coastline Logistics",
    p_contact_name: "Ngozi Eze",
    p_contact_email: `ops-${suffix}@coastline.example`,
  });
  if (client.error) throw new Error(client.error.message);
  const admin = adminClient();
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
  const worker = await admin
    .from("workers")
    .insert({
      organisation_id: owner.orgId,
      employment_type: "permanent",
      start_date: "2024-03-03",
      staff_id: `CK-${suffix.slice(0, 4)}`,
      first_name: "Musa",
      last_name: "Bello",
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
  const invite = await ownerClient.rpc("create_worker_invites", {
    p_organisation_id: owner.orgId,
    p_worker_ids: [worker.data.id],
    p_sent_via: "print",
  });
  if (invite.error) throw new Error(invite.error.message);
  return { orgId: owner.orgId, workerId: worker.data.id, token: invite.data![0]!.token };
}

async function phone(
  browser: Browser,
  baseURL: string | undefined,
  position: { latitude: number; longitude: number },
  skewMs = 0,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    geolocation: { ...position, accuracy: 10 },
    permissions: ["geolocation", "camera"],
  });
  if (skewMs) {
    // The phone's clock runs fast; performance.now() (monotonic) is untouched.
    await context.addInitScript((skew: number) => {
      const RealDate = Date;
      class SkewedDate extends RealDate {
        constructor(...args: unknown[]) {
          if (args.length === 0) super(RealDate.now() + skew);
          else super(...(args as [string]));
        }
        static override now() {
          return RealDate.now() + skew;
        }
      }
      (window as unknown as { Date: DateConstructor }).Date = SkewedDate as DateConstructor;
    }, skewMs);
  }
  return { context, page: await context.newPage() };
}

/** Sets the PIN from the invite, then agrees to location and selfie on the clock screen. */
async function signInAndAgree(page: Page, token: string) {
  await page.goto(`/m/invite/${token}`);
  await page.getByLabel("New PIN").fill(PIN);
  await page.getByLabel("Type the PIN again").fill(PIN);
  await page.getByRole("checkbox", { name: /I have read this/ }).check();
  await page.getByRole("button", { name: "Set PIN and sign in" }).click();
  await expect(page).toHaveURL(/\/m$/, { timeout: 15_000 });
  await expect(page.getByTestId("clock-button")).toHaveText(/Clock in/);

  await page.getByTestId("clock-button").click();
  await expect(page.getByTestId("clock-consent")).toBeVisible();
  for (const kind of ["location", "selfie"]) {
    const card = page.getByTestId(`consent-${kind}`);
    await card.getByRole("button", { name: "I agree" }).click();
    await expect(card).toHaveAttribute("data-agreed", "yes", { timeout: 15_000 });
  }
  await page.goto("/m/clock");
  await expect(page.getByTestId("clock-title")).toHaveText("Clock in");
}

async function punchesOf(workerId: string) {
  const { data, error } = await adminClient()
    .from("punches")
    .select(
      "id, kind, recorded_at, device_time, clock_drift_seconds, geofence_result, flags, outside_reason, selfie_path",
    )
    .eq("worker_id", workerId)
    .order("recorded_at");
  if (error) throw new Error(error.message);
  return data;
}

async function takeSelfie(page: Page) {
  const capture = page.getByRole("button", { name: "Capture and clock in" });
  await expect(capture).toBeEnabled({ timeout: 15_000 });
  await capture.click();
}

test.describe("clock in", () => {
  test.skip(!supabaseReady, NEEDS_SUPABASE);

  test("inside the site, with a selfie", async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-390", "The worker app is phone-first.");
    test.setTimeout(120_000);
    const setup = await setUp("clock-in");
    const { context, page } = await phone(browser, testInfo.project.use.baseURL, north(40));
    await signInAndAgree(page, setup.token);

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("You are 40 m from the site", {
      timeout: 25_000,
    });
    await expect(page.getByText("Inside Apapa Warehouse 3. Next, take a selfie.")).toBeVisible();
    await page.getByRole("button", { name: "Take selfie" }).click();
    await expect(
      page.getByText(
        "Put your face in the oval. The photo is small and used only to confirm it is you.",
      ),
    ).toBeVisible();
    await takeSelfie(page);

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Clocked in at \d\d:\d\d$/);
    await expect(page.getByTestId("clock-note")).toHaveText(
      "Inside the site, selfie taken. Have a good shift.",
    );
    await expect(page.getByTestId("clock-send-status")).toHaveText("Sent to your company.", {
      timeout: 20_000,
    });
    await expect
      .poll(async () => (await punchesOf(setup.workerId))[0]?.selfie_path ?? null, {
        timeout: 15_000,
      })
      .toMatch(new RegExp(`^${setup.orgId}/\\d{4}-\\d{2}/[0-9a-f-]{36}\\.(webp|jpg)$`));
    const [punch] = await punchesOf(setup.workerId);
    expect(punch).toMatchObject({ kind: "in", geofence_result: "inside" });
    expect(punch!.flags).not.toContain("outside");

    // Home now offers Clock out.
    await page.getByRole("link", { name: "Back to home" }).click();
    await expect(page.getByTestId("clock-button")).toHaveText(/Clock out/);
    await context.close();
  });

  test("outside the site, with a reason", async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-390", "The worker app is phone-first.");
    test.setTimeout(120_000);
    const setup = await setUp("clock-out-site");
    const { context, page } = await phone(browser, testInfo.project.use.baseURL, north(620));
    await signInAndAgree(page, setup.token);

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      /^You are 6\d\d m from the site$/,
      {
        timeout: 25_000,
      },
    );
    await expect(
      page.getByText("You can still clock in. Your supervisor will check it. Why are you outside?"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Gate locked, waiting outside" }).click();
    await page.getByRole("button", { name: "Send anyway" }).click();
    await takeSelfie(page);

    await expect(page.getByTestId("clock-note")).toHaveText(
      "Sent for review because you were outside the site. Reason: Gate locked, waiting outside.",
    );
    await expect(page.getByTestId("clock-send-status")).toHaveText("Sent to your company.", {
      timeout: 20_000,
    });
    const [punch] = await punchesOf(setup.workerId);
    expect(punch).toMatchObject({ geofence_result: "outside", outside_reason: "gate_locked" });
    expect(punch!.flags).toContain("outside");
    await context.close();
  });

  test("offline with a wrong phone clock: saved on the phone, synced with the server's time and flagged", async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-390", "The worker app is phone-first.");
    test.setTimeout(150_000);
    const setup = await setUp("clock-offline");
    const { context, page } = await phone(
      browser,
      testInfo.project.use.baseURL,
      north(620),
      SKEW_MS,
    );
    await signInAndAgree(page, setup.token);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/m from the site$/, {
      timeout: 25_000,
    });

    // No network from here: the whole clock-in happens on the phone.
    await context.setOffline(true);
    await expect(page.getByTestId("offline-banner")).toBeVisible();
    await page.getByRole("button", { name: "Phone location is wrong" }).click();
    await page.getByRole("button", { name: "Send anyway" }).click();
    await takeSelfie(page);
    const clickedAt = Date.now();

    await expect(page.getByTestId("clock-send-status")).toHaveText(
      "Saved on phone. Will send when network returns.",
    );
    await expect(page.getByTestId("clock-note")).toHaveText(
      "Sent for review because you were outside the site. Reason: Phone location is wrong.",
    );
    // The time shown is the phone's (10 minutes fast); nothing has reached the server.
    await page.waitForTimeout(3_000);
    expect(await punchesOf(setup.workerId)).toEqual([]);

    await context.setOffline(false);
    await expect(page.getByTestId("clock-send-status")).toHaveText("Sent to your company.", {
      timeout: 30_000,
    });
    const punches = await punchesOf(setup.workerId);
    expect(punches).toHaveLength(1);
    const punch = punches[0]!;
    const recordedAt = Date.parse(punch.recorded_at);
    // Server-corrected: within a few seconds of the real tap, not the phone's +10 minutes.
    expect(Math.abs(recordedAt - clickedAt)).toBeLessThan(15_000);
    expect(Date.parse(punch.device_time) - recordedAt).toBeGreaterThan(SKEW_MS - 15_000);
    expect(punch.clock_drift_seconds).toBeGreaterThan(585);
    expect(punch.clock_drift_seconds).toBeLessThan(615);
    expect(punch.flags).toEqual(expect.arrayContaining(["outside", "clock_drift"]));
    expect(punch).toMatchObject({ geofence_result: "outside", outside_reason: "location_wrong" });
    await context.close();
  });
});
