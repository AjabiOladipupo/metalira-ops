/**
 * Slice 3.4: the installable, offline-capable worker app. Against the production build:
 * the service worker registers for /m only (never the manager app), a worker page opened with
 * no network shows the offline screen with the black banner, and a queued item survives a
 * reload offline and drains through the test sender once the network returns.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient, anonClient } from "../rls/helpers/supabase";
import { NEEDS_SUPABASE, createOwner, supabaseReady, uniqueSuffix } from "./helpers/auth";

const BANNER = "No network. Saved on phone, will send when network returns.";

/** Waits until the /m service worker is active and controls this page. */
async function waitForWorker(page: Page): Promise<string> {
  const scope = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return reg.scope;
  });
  // clientsClaim: the first page is taken over once the worker activates.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  return scope;
}

test.describe("worker app service worker", () => {
  test("registers for /m only and serves the offline screen when there is no network", async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-390", "The worker app is phone-first.");
    await page.goto("/m/sign-in");
    const scope = await waitForWorker(page);
    expect(scope).toBe(`${baseURL}/m`);

    // The service worker file itself is never cached by the browser.
    const sw = await page.request.get("/sw.js");
    expect(sw.ok()).toBe(true);
    expect(sw.headers()["cache-control"]).toContain("no-store");

    // Not the manager app, the marketing pages or the manager sign-in.
    for (const path of ["/", "/sign-in"]) {
      await page.goto(path);
      expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
    }
    expect(
      await page.evaluate(
        async () => (await navigator.serviceWorker.getRegistration("/app")) ?? null,
      ),
    ).toBeNull();

    // Offline: the banner shows on the open worker screen...
    await page.goto("/m/sign-in");
    await waitForWorker(page);
    await context.setOffline(true);
    await expect(page.getByTestId("offline-banner")).toHaveText(BANNER);

    // ...and a worker page that needs the network falls back to the precached offline screen.
    await page.goto("/m/clock");
    await expect(page.getByRole("heading", { level: 1, name: "No network" })).toBeVisible();
    await expect(page.locator('[data-illustration="offline"]')).toHaveAttribute("height", "160");
    await expect(page.getByTestId("offline-banner")).toBeVisible();

    await context.setOffline(false);
    await expect(page.getByTestId("offline-banner")).toHaveCount(0);
  });
});

test.describe("offline queue", () => {
  test.skip(!supabaseReady, NEEDS_SUPABASE);

  test("a queued item survives a reload offline and drains when the network returns", async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-390", "The worker app is phone-first.");
    test.setTimeout(120_000);
    const PIN = "583104";
    const suffix = uniqueSuffix();
    const owner = await createOwner("offline", `Offline Co ${suffix}`);
    const worker = await adminClient()
      .from("workers")
      .insert({
        organisation_id: owner.orgId,
        employment_type: "permanent",
        start_date: "2024-03-03",
        staff_id: `OF-${suffix.slice(0, 4)}`,
        first_name: "Musa",
        last_name: "Bello",
      })
      .select("id")
      .single();
    if (worker.error) throw new Error(worker.error.message);
    const ownerClient = anonClient();
    await ownerClient.auth.signInWithPassword({ email: owner.email, password: owner.password });
    const invite = await ownerClient.rpc("create_worker_invites", {
      p_organisation_id: owner.orgId,
      p_worker_ids: [worker.data.id],
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
    await waitForWorker(page);
    // Set only once the test sender wraps the punch sender and the queue is open (queue-owner.tsx),
    // so no drain can hand the ping to the punch sender, which refuses it as `invalid`.
    await page.waitForFunction(() => window.__metaliraQueue !== undefined);

    // Offline: the punch is saved on the phone and counted in the banner.
    await context.setOffline(true);
    await page.evaluate(() => window.__metaliraQueue!.queuePing("offline punch"));
    await expect(page.getByTestId("offline-count")).toHaveText("1 punch saved on phone");

    // A reload with no network lands on the offline screen, which still counts it.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "No network" })).toBeVisible();
    await expect(page.getByTestId("offline-page-count")).toHaveText("1 punch saved on phone");

    // Network back: the worker app drains the queue through the test sender.
    await context.setOffline(false);
    await page.goto("/m");
    await page.waitForFunction(() => window.__metaliraQueue !== undefined);
    await expect
      .poll(() => page.evaluate(() => window.__metaliraQueue!.pending()), { timeout: 15_000 })
      .toBe(0);
    await expect(page.getByTestId("sending-banner")).toHaveCount(0);
    await context.close();
  });
});
