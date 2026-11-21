import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { lagosToday } from "../../src/lib/dates";
import { adminClient, pgClient } from "../rls/helpers/supabase";
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

const MIN = 60_000;
const CENTRE = "SRID=4326;POINT(3.3611 6.4474)";

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/**
 * Apapa Warehouse 3 with three guards around now: Daniel Okon 25 minutes late with no clock-in,
 * Ngozi Eze on site (clocked in outside the site), Yusuf Bello starting in an hour. Shifts,
 * assignments and punches are written as the database owner with triggers off for the
 * transaction, so their times can sit around now (the roster and punch rules have their own
 * specs).
 */
async function seedBoard() {
  const admin = adminClient();
  const owner = await createOwner("board-owner", `Kola Guarding ${uniqueSuffix()}`);
  const hr = await createAccount("board-hr", "Halima Bello");
  await addMembership(owner.orgId, hr.userId, "hr");
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

  const now = Date.now();
  const people = [
    { name: "Daniel Okon", phone: "08031234410", start: now - 25 * MIN, post: "Gate A · Day" },
    { name: "Ngozi Eze", phone: "08051112222", start: now - 60 * MIN, post: "Floor · Day" },
    { name: "Yusuf Bello", phone: "08061113333", start: now + 60 * MIN, post: "Patrol · Day" },
  ];
  const ids: Record<string, { worker: string; assignment: string }> = {};
  const db = await pgClient();
  try {
    for (const [i, p] of people.entries()) {
      const [first, last] = p.name.split(" ");
      const w = await admin
        .from("workers")
        .insert({
          organisation_id: org,
          staff_id: `EMP-00${i + 1}`,
          first_name: first!,
          last_name: last!,
          phone: p.phone,
          employment_type: "permanent",
          start_date: "2025-01-06",
        })
        .select("id")
        .single();
      expect(w.error).toBeNull();
      const day = lagosToday(new Date(p.start));
      const [post, shift, assignment] = [randomUUID(), randomUUID(), randomUUID()];
      const ends = new Date(p.start + 12 * 60 * MIN);
      await db.query("begin");
      await db.query("set local session_replication_role = replica");
      await db.query(
        `insert into public.posts (id, organisation_id, contract_id, site_id, name, role, band, unit, opened_on)
         values ($1, $2, $3, $4, $5, 'Guard', 'Day', 'shift', $6)`,
        [post, org, randomUUID(), apapa, p.post, day],
      );
      await db.query(
        `insert into public.shifts (id, organisation_id, post_id, contract_id, site_id, shift_date, starts_at, ends_at, required_count)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 1)`,
        [shift, org, post, randomUUID(), apapa, day, new Date(p.start), ends],
      );
      await db.query(
        `insert into public.shift_assignments (id, organisation_id, shift_id, site_id, shift_date, worker_id, starts_at, ends_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [assignment, org, shift, apapa, day, w.data!.id, new Date(p.start), ends],
      );
      await db.query("commit");
      ids[first!] = { worker: w.data!.id, assignment };
    }
    const at = new Date(now - 58 * MIN);
    await db.query(
      `insert into public.punches (organisation_id, worker_id, kind, recorded_by_user, client_event_id,
         shift_assignment_id, site_id, device_time, received_at, recorded_at, time_source,
         clock_drift_seconds, geofence_result, outside_reason, flags, payload_hash)
       values ($1, $2, 'in', $3, $4, $5, $6, $7, $7, $7, 'elapsed', 0, 'outside', 'gate_locked',
         array['outside'], md5($4::text))`,
      [org, ids.Ngozi!.worker, randomUUID(), randomUUID(), ids.Ngozi!.assignment, apapa, at],
    );
  } finally {
    await db.end();
  }
  return { owner, hr, apapa, ids };
}

test("the live board shows who is late, on site and starting, with Call and Send replacement", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const seed = await seedBoard();
  await signInViaUi(page, seed.owner.email, seed.owner.password);
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });
  await page.goto("/app/attendance");

  await expect(page.getByTestId("board-headline")).toHaveText("2 on shift now");
  await expect(page.getByTestId("tile-late")).toContainText("1");
  await expect(page.getByTestId("tile-on_site")).toContainText("1");
  await expect(page.getByTestId("tile-starting")).toContainText("1");
  await expect(page.getByTestId("tile-no_show")).toContainText("0");
  // What needs action opens first.
  await expect(page.getByTestId("tile-late")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("board-list-title")).toHaveText("Late now (1)");

  const mobile = testInfo.project.name === "mobile-390";
  const item = page.getByTestId(mobile ? "board-card" : "board-row").first();
  await expect(item).toContainText("Daniel Okon");
  await expect(item).toContainText("Apapa Warehouse 3 · Gate A · Day");
  await expect(item).toContainText(/Late 2[5-6] min/);
  await expect(item.getByRole("link", { name: "Call Daniel Okon" })).toHaveAttribute(
    "href",
    "tel:08031234410",
  );
  const replace = item.getByRole("link", { name: /Send replacement for Daniel Okon/ });
  await expect(replace).toHaveAttribute(
    "href",
    new RegExp(
      `^/app/roster\\?site=${seed.apapa}&week=\\d{4}-\\d{2}-\\d{2}&post=[0-9a-f-]+&date=\\d{4}-\\d{2}-\\d{2}&replace=${seed.ids.Daniel!.assignment}$`,
    ),
  );

  // The tiles filter the list; flags show in words.
  await page.getByTestId("tile-on_site").click();
  await expect(page.getByTestId("board-list-title")).toHaveText("On site now (1)");
  const onSite = page.getByTestId(mobile ? "board-card" : "board-row").first();
  await expect(onSite).toContainText("Ngozi Eze");
  await expect(onSite).toContainText("Outside the site");
  await expect(onSite).toContainText("clock-in");
  await expect(onSite.getByRole("link", { name: /Call/ })).toHaveCount(0);

  // Search across the board.
  await page.getByTestId("tile-starting").click();
  await page.getByRole("searchbox", { name: "Find a worker or post" }).fill("patrol");
  await expect(page.getByTestId(mobile ? "board-card" : "board-row")).toHaveCount(1);
  await expect(page.getByTestId(mobile ? "board-card" : "board-row").first()).toContainText(
    "Yusuf Bello",
  );

  // By site, with the last sync.
  const siteRow = page.getByTestId("by-site-row").first();
  await expect(siteRow).toContainText("Apapa Warehouse 3");
  await expect(siteRow).toContainText(/min ago|h ago|Just now/);
  await expect(page.getByTestId("board-updated")).toContainText("Live · updated");
  await expectNoHorizontalScroll(page);
});

test("hr opens the board read-only: no Send replacement", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const seed = await seedBoard();
  await signInViaUi(page, seed.hr.email, seed.hr.password);
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });
  await page.goto("/app/attendance");
  const mobile = testInfo.project.name === "mobile-390";
  const item = page.getByTestId(mobile ? "board-card" : "board-row").first();
  await expect(item).toContainText("Daniel Okon");
  await expect(item.getByRole("link", { name: "Call Daniel Okon" })).toBeVisible();
  await expect(item.getByRole("link", { name: /Send replacement/ })).toHaveCount(0);
});
