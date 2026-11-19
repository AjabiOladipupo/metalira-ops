/**
 * Slice 2.5: a contract's headcount (`headcount_requirements`).
 * - owner, admin and ops_manager add, change and remove rows on a draft; finance reads them; hr
 *   and line managers see none of it.
 * - The database works out the duration (a night shift ending the next day, a 24-hour post),
 *   sorts the days, keeps one post of a name and band per site, keeps a row's site on the
 *   contract, and refuses any change once the contract has left draft, for every role and the
 *   database owner.
 * - `private.headcount_unpriced_rows` lists the rows with no rate line (activation, 2.7).
 * - Every change is audited with its actor and channel; another company can't read or write it.
 */
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays, lagosToday } from "@/lib/dates";
import type { Json } from "@/types/db";

import {
  adminClient,
  createTenantUser,
  createTestUser,
  pgClient,
  type Client,
  type TenantUser,
  type TestUser,
} from "./helpers/supabase";

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
let ops: TestUser;
let finance: TestUser;
let hr: TestUser;
let lineManager: TestUser;
let clientId: string;
let apapa: string;
let gateB: string;
let lekki: string;

const today = lagosToday();
const start = addDays(today, 7);

async function addMember(user: TestUser, role: "ops_manager" | "hr" | "finance" | "line_manager") {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: owner.orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

async function newContract(sites: string[] = [apapa, gateB], type = "manned_post") {
  const { data, error } = await ops.client.rpc("create_contract", {
    p_organisation_id: owner.orgId,
    p_contract: {
      client_id: clientId,
      name: "Coastline guarding",
      type,
      start_date: start,
    } as Json,
    p_site_ids: sites,
  });
  expect(error).toBeNull();
  const card = await ops.client.rpc("save_draft_rate_card", {
    p_organisation_id: owner.orgId,
    p_contract_id: data!,
    p_effective_from: start,
    p_lines: [
      { role: "Guard", band: "Day", unit: "shift", rate_kobo: "1250000" },
      { role: "Guard", band: "Night", unit: "shift", rate_kobo: "1500000" },
    ] as Json,
  });
  expect(card.error).toBeNull();
  return data!;
}

function row(contractId: string, over: Record<string, unknown> = {}) {
  return {
    organisation_id: owner.orgId,
    contract_id: contractId,
    site_id: apapa,
    post_name: "Gate A",
    role: "Guard",
    band: "Day",
    unit: "shift",
    days_of_week: [1, 2, 3, 4, 5, 6, 7],
    start_time: "06:00",
    end_time: "18:00",
    required_count: 1,
    ...over,
  };
}

async function insertAs(who: TestUser, values: Record<string, unknown>) {
  return who.client
    .from("headcount_requirements")
    .insert(values as never)
    .select("id, days_of_week, duration_minutes, kind, band, post_name")
    .single();
}

async function activate(contractId: string) {
  // Activation is slice 2.7; the test flips the status as the database owner.
  await db.query("update public.contracts set status = 'active' where id = $1", [contractId]);
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("hc-owner", "Headcount Org");
  other = await createTenantUser("hc-other", "Other Headcount Org");
  ops = await createTestUser("hc-ops", "Tunde Ops");
  finance = await createTestUser("hc-fin", "Femi Finance");
  hr = await createTestUser("hc-hr", "Hauwa HR");
  lineManager = await createTestUser("hc-lm", "Lara Line");
  await addMember(ops, "ops_manager");
  await addMember(finance, "finance");
  await addMember(hr, "hr");
  await addMember(lineManager, "line_manager");

  const { data, error } = await owner.client.rpc("create_client", {
    p_organisation_id: owner.orgId,
    p_name: "Coastline Logistics",
    p_site_name: "Apapa Warehouse 3",
  });
  expect(error).toBeNull();
  clientId = data!;
  await admin.from("sites").insert([
    { organisation_id: owner.orgId, client_id: clientId, name: "Gate B" },
    { organisation_id: owner.orgId, client_id: clientId, name: "Lekki Phase 1" },
  ]);
  const { data: sites } = await admin.from("sites").select("id, name").eq("client_id", clientId);
  const byName = Object.fromEntries((sites ?? []).map((s) => [s.name, s.id]));
  apapa = byName["Apapa Warehouse 3"]!;
  gateB = byName["Gate B"]!;
  lekki = byName["Lekki Phase 1"]!;
});

afterAll(async () => {
  await db?.end();
});

describe("headcount rows", () => {
  it("adds four rows at two sites, working out each duration and sorting the days", async () => {
    const id = await newContract();
    const results = await Promise.all([
      insertAs(ops, row(id)),
      insertAs(
        ops,
        row(id, { band: "Night", start_time: "18:00", end_time: "06:00", days_of_week: [7, 1, 1] }),
      ),
      insertAs(
        ops,
        row(id, {
          site_id: gateB,
          post_name: " Patrol ",
          band: "Night",
          start_time: "18:00",
          end_time: "06:00",
        }),
      ),
      insertAs(
        ops,
        row(id, {
          site_id: gateB,
          post_name: "",
          band: "",
          unit: "hour",
          start_time: "06:00",
          end_time: "06:00",
        }),
      ),
    ]);
    for (const result of results) expect(result.error).toBeNull();
    const [day, night, patrol, allDay] = results.map((r) => r.data!);
    expect(day).toMatchObject({ duration_minutes: 720, kind: "shift" });
    expect(night).toMatchObject({ duration_minutes: 720, days_of_week: [1, 7] });
    expect(patrol).toMatchObject({ post_name: "Patrol" });
    expect(allDay).toMatchObject({ duration_minutes: 1440, band: "standard", post_name: null });

    const { data: audit } = await admin
      .from("audit_log")
      .select("action, actor_id, channel")
      .eq("entity_id", day!.id);
    expect(audit).toEqual([
      { action: "headcount_requirements.insert", actor_id: ops.id, channel: "web" },
    ]);
  });

  it("refuses bad rows in the database", async () => {
    const id = await newContract();
    const bad: Record<string, unknown>[] = [
      { days_of_week: [] },
      { days_of_week: [0, 1] },
      { days_of_week: [8] },
      { start_time: "06:10" },
      { required_count: 0 },
      { required_count: 201 },
      { unit: "month" },
      { role: "<script>" },
    ];
    for (const over of bad) {
      const res = await insertAs(ops, row(id, over));
      expect(res.error?.code, JSON.stringify(over)).toBe("23514");
    }
  });

  it("keeps one post of a name and band per site, ignoring case", async () => {
    const id = await newContract();
    expect((await insertAs(ops, row(id))).error).toBeNull();
    const dup = await insertAs(ops, row(id, { post_name: "gate a", band: "DAY" }));
    expect(dup.error?.code).toBe("23505");
    expect((await insertAs(ops, row(id, { site_id: gateB }))).error).toBeNull();
  });

  it("keeps a row's site on the contract, and the site on the contract while it has rows", async () => {
    const id = await newContract([apapa]);
    const off = await insertAs(ops, row(id, { site_id: lekki }));
    expect(off.error?.code).toBe("23503");
    expect((await insertAs(ops, row(id))).error).toBeNull();
    const drop = await ops.client.rpc("update_draft_contract", {
      p_organisation_id: owner.orgId,
      p_contract_id: id,
      p_contract: { name: "Coastline guarding", type: "manned_post", start_date: start } as Json,
      p_site_ids: [],
    });
    expect(drop.error?.code).toBe("MLHC2");
    expect(drop.error?.message).toContain("Apapa Warehouse 3");
  });

  it("lets owner and admin-like editors change and remove a draft's rows", async () => {
    const id = await newContract();
    const added = await insertAs(owner, row(id));
    expect(added.error).toBeNull();
    const changed = await ops.client
      .from("headcount_requirements")
      .update({ required_count: 3, days_of_week: [5, 1] })
      .eq("id", added.data!.id)
      .select("required_count, days_of_week")
      .single();
    expect(changed.data).toEqual({ required_count: 3, days_of_week: [1, 5] });
    const moved = await ops.client
      .from("headcount_requirements")
      .update({ contract_id: id } as never)
      .eq("id", added.data!.id);
    expect(moved.error?.code).toBe("42501");
    const removed = await ops.client
      .from("headcount_requirements")
      .delete()
      .eq("id", added.data!.id)
      .select("id");
    expect(removed.data).toHaveLength(1);
    const { data: audit } = await admin
      .from("audit_log")
      .select("action, actor_id")
      .eq("entity_id", added.data!.id)
      .order("at");
    expect(audit?.map((a) => a.action)).toEqual([
      "headcount_requirements.insert",
      "headcount_requirements.update",
      "headcount_requirements.delete",
    ]);
  });

  it("lets finance read but not write, and hides headcount from hr and line managers", async () => {
    const id = await newContract();
    const added = await insertAs(ops, row(id));
    expect(added.error).toBeNull();
    const fin = await finance.client
      .from("headcount_requirements")
      .select("id")
      .eq("contract_id", id);
    expect(fin.data).toHaveLength(1);
    for (const who of [hr, lineManager]) {
      const res = await who.client
        .from("headcount_requirements")
        .select("id")
        .eq("contract_id", id);
      expect(res.data).toEqual([]);
    }
    for (const who of [finance, hr, lineManager]) {
      const insert = await insertAs(who, row(id, { post_name: "Gate Z" }));
      expect(insert.error?.code).toBe("42501");
      const update = await who.client
        .from("headcount_requirements")
        .update({ required_count: 9 })
        .eq("id", added.data!.id)
        .select();
      expect(update.data ?? []).toEqual([]);
      const del = await who.client
        .from("headcount_requirements")
        .delete()
        .eq("id", added.data!.id)
        .select();
      expect(del.data ?? []).toEqual([]);
    }
    const { data: still } = await admin
      .from("headcount_requirements")
      .select("required_count")
      .eq("id", added.data!.id)
      .single();
    expect(still?.required_count).toBe(1);
  });

  it("freezes the rows once the contract has left draft, even for the database owner", async () => {
    const id = await newContract();
    const added = await insertAs(ops, row(id));
    expect(added.error).toBeNull();
    await activate(id);

    const insert = await insertAs(owner, row(id, { post_name: "Gate C" }));
    expect(insert.error?.code).toBe("MLHC1");
    const update = await ops.client
      .from("headcount_requirements")
      .update({ required_count: 2 })
      .eq("id", added.data!.id);
    expect(update.error?.code).toBe("MLHC1");
    const del = await ops.client.from("headcount_requirements").delete().eq("id", added.data!.id);
    expect(del.error?.code).toBe("MLHC1");
    await expect(
      db.query("update public.headcount_requirements set required_count = 5 where id = $1", [
        added.data!.id,
      ]),
    ).rejects.toMatchObject({ code: "MLHC1" });
    await expect(
      db.query("delete from public.headcount_requirements where id = $1", [added.data!.id]),
    ).rejects.toMatchObject({ code: "MLHC1" });
  });

  it("lists rows with no rate line, only on contracts priced per row", async () => {
    const id = await newContract();
    await insertAs(ops, row(id));
    const supervisor = await insertAs(ops, row(id, { post_name: "Gate C", band: "Supervisor" }));
    const hourly = await insertAs(ops, row(id, { post_name: "Gate D", unit: "hour" }));
    const { rows } = await db.query<{
      headcount_requirement_id: string;
      band: string;
      unit: string;
    }>("select * from private.headcount_unpriced_rows($1, $2, $3)", [owner.orgId, id, start]);
    expect(rows.map((r) => r.headcount_requirement_id).sort()).toEqual(
      [supervisor.data!.id, hourly.data!.id].sort(),
    );
    // Before the rate card starts, nothing is priced.
    const early = await db.query("select * from private.headcount_unpriced_rows($1, $2, $3)", [
      owner.orgId,
      id,
      addDays(start, -1),
    ]);
    expect(early.rows).toHaveLength(3);

    const monthly = await newContract([apapa], "fixed_monthly");
    await insertAs(ops, row(monthly, { band: "Supervisor" }));
    const none = await db.query("select * from private.headcount_unpriced_rows($1, $2, $3)", [
      owner.orgId,
      monthly,
      start,
    ]);
    expect(none.rows).toEqual([]);
  });
});

describe("another company", () => {
  it("can't read or write a contract's headcount", async () => {
    const id = await newContract();
    const added = await insertAs(ops, row(id));
    expect(added.error).toBeNull();
    const read = await other.client
      .from("headcount_requirements")
      .select("id")
      .eq("contract_id", id);
    expect(read.data).toEqual([]);
    const insert = await insertAs(other, row(id, { post_name: "Hijack" }));
    expect(insert.error?.code).toBe("42501");
    const update = await other.client
      .from("headcount_requirements")
      .update({ required_count: 9 })
      .eq("id", added.data!.id)
      .select();
    expect(update.data ?? []).toEqual([]);
    const del = await other.client
      .from("headcount_requirements")
      .delete()
      .eq("id", added.data!.id)
      .select();
    expect(del.data ?? []).toEqual([]);
    // Pointing a row of its own at the victim's contract fails the composite keys.
    const cross = await other.client.from("headcount_requirements").insert({
      ...row(id),
      organisation_id: other.orgId,
    } as never);
    expect(cross.error).not.toBeNull();
  });
});
