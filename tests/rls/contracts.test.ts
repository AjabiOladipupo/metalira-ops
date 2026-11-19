/**
 * Slice 2.4: contracts, dated rate cards and WHT rates.
 * - owner, admin and ops_manager write contracts and rate cards; finance reads them and writes
 *   WHT rates; hr and line managers see none of it.
 * - Rate cards and WHT rates have no write grants: only the SQL functions write them, and the
 *   database refuses editing a version in force or in the past on a live contract, overlaps and
 *   backdated changes.
 * - Another company can't read or write any of it, through the tables or the functions.
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

const PERMISSION_DENIED = "42501";

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
let ops: TestUser;
let finance: TestUser;
let hr: TestUser;
let lineManager: TestUser;
let clientId: string;
let otherClientId: string;
let siteA: string;
let siteB: string;
let foreignSite: string;

const today = lagosToday();
const start = addDays(today, -30);

const DAY = {
  role: "Guard",
  band: "Day",
  unit: "shift",
  rate_kobo: "1250000",
  ot_multiplier_bps: 15000,
};
const NIGHT = {
  role: "Guard",
  band: "Night",
  unit: "shift",
  rate_kobo: "1500000",
  ot_rate_kobo: "190000",
};

async function addMember(user: TestUser, role: "ops_manager" | "hr" | "finance" | "line_manager") {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: owner.orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

async function newContract(
  who: TestUser,
  fields: Record<string, unknown> = {},
  sites: string[] = [siteA],
): Promise<string> {
  const { data, error } = await who.client.rpc("create_contract", {
    p_organisation_id: owner.orgId,
    p_contract: {
      client_id: clientId,
      name: "Apapa guarding",
      type: "manned_post",
      start_date: start,
      ...fields,
    } as Json,
    p_site_ids: sites,
  });
  expect(error).toBeNull();
  return data!;
}

async function saveDraft(contractId: string, lines: unknown[] = [DAY, NIGHT], from = start) {
  const { data, error } = await ops.client.rpc("save_draft_rate_card", {
    p_organisation_id: owner.orgId,
    p_contract_id: contractId,
    p_effective_from: from,
    p_lines: lines as Json,
  });
  expect(error).toBeNull();
  return data!;
}

async function versions(contractId: string) {
  const { data } = await admin
    .from("rate_cards")
    .select("id, effective_from, effective_to")
    .eq("contract_id", contractId)
    .order("effective_from");
  return data ?? [];
}

async function activate(contractId: string) {
  // Activation is slice 2.7; the test flips the status as the database owner.
  await db.query("update public.contracts set status = 'active' where id = $1", [contractId]);
}

async function lastAudit(entityId: string, action: string) {
  const { data } = await admin
    .from("audit_log")
    .select("action, actor_id, channel, before, after")
    .eq("entity_id", entityId)
    .eq("action", action)
    .order("at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("ct-owner", "Contracts Org");
  other = await createTenantUser("ct-other", "Other Contracts Org");
  ops = await createTestUser("ct-ops", "Tunde Ops");
  finance = await createTestUser("ct-fin", "Femi Finance");
  hr = await createTestUser("ct-hr", "Hauwa HR");
  lineManager = await createTestUser("ct-lm", "Lara Line");
  await addMember(ops, "ops_manager");
  await addMember(finance, "finance");
  await addMember(hr, "hr");
  await addMember(lineManager, "line_manager");
  await admin.from("organisations").update({ vat_registered: true }).eq("id", owner.orgId);

  const make = async (org: TenantUser, name: string, sites: string[]) => {
    const { data, error } = await org.client.rpc("create_client", {
      p_organisation_id: org.orgId,
      p_name: name,
      p_site_name: sites[0],
    });
    expect(error).toBeNull();
    for (const site of sites.slice(1)) {
      await admin
        .from("sites")
        .insert({ organisation_id: org.orgId, client_id: data!, name: site });
    }
    const { data: rows } = await admin.from("sites").select("id, name").eq("client_id", data!);
    return { id: data!, sites: Object.fromEntries((rows ?? []).map((r) => [r.name, r.id])) };
  };
  const coastline = await make(owner, "Coastline Logistics", ["Apapa Warehouse 3", "Gate B"]);
  clientId = coastline.id;
  siteA = coastline.sites["Apapa Warehouse 3"]!;
  siteB = coastline.sites["Gate B"]!;
  const greenfield = await make(owner, "Greenfield Estates", ["Lekki Phase 1"]);
  otherClientId = greenfield.id;
  foreignSite = greenfield.sites["Lekki Phase 1"]!;
});

afterAll(async () => {
  await db?.end();
});

describe("contracts", () => {
  it("creates a draft with its sites, the next CTR reference and VAT from the company", async () => {
    const first = await newContract(ops, {}, [siteA, siteB]);
    const second = await newContract(ops, { name: "Gate B patrols", type: "per_visit" });
    const { data } = await admin
      .from("contracts")
      .select("id, reference, status, vat_applies, contract_sites(site_id)")
      .in("id", [first, second])
      .order("created_at");
    expect(data?.map((c) => [c.reference, c.status, c.vat_applies])).toEqual([
      ["CTR-0001", "draft", true],
      ["CTR-0002", "draft", true],
    ]);
    expect(data?.[0]?.contract_sites).toHaveLength(2);
    expect((await lastAudit(first, "contracts.insert"))?.actor_id).toBe(ops.id);
  });

  it("refuses a duplicate reference, ignoring case, and a site of another client", async () => {
    const dup = await ops.client.rpc("create_contract", {
      p_organisation_id: owner.orgId,
      p_contract: {
        client_id: clientId,
        name: "Dup",
        type: "per_job",
        start_date: start,
        reference: "ctr-0001",
      } as Json,
    });
    expect(dup.error?.code).toBe("23505");
    const wrong = await ops.client.rpc("create_contract", {
      p_organisation_id: owner.orgId,
      p_contract: {
        client_id: clientId,
        name: "Wrong site",
        type: "per_job",
        start_date: start,
      } as Json,
      p_site_ids: [foreignSite],
    });
    expect(wrong.error?.code).toBe("MLCO2");
    const { count } = await admin
      .from("contracts")
      .select("id", { count: "exact", head: true })
      .eq("name", "Wrong site");
    expect(count).toBe(0);
  });

  it("lets finance read but not write, and hides contracts from hr and line managers", async () => {
    const id = await newContract(ops);
    await saveDraft(id);
    const wht = await owner.client.rpc("add_contract_wht_rate", {
      p_organisation_id: owner.orgId,
      p_contract_id: id,
      p_rate_bps: 500,
      p_effective_from: start,
    });
    expect(wht.error).toBeNull();
    for (const table of [
      "contracts",
      "rate_cards",
      "contract_wht_rates",
      "contract_sites",
    ] as const) {
      const fin = await finance.client.from(table).select("id").eq("organisation_id", owner.orgId);
      expect(fin.data?.length, table).toBeGreaterThan(0);
      for (const who of [hr, lineManager]) {
        const res = await who.client.from(table).select("id").eq("organisation_id", owner.orgId);
        expect(res.data, table).toEqual([]);
      }
    }
    const insert = await finance.client.rpc("create_contract", {
      p_organisation_id: owner.orgId,
      p_contract: {
        client_id: clientId,
        name: "Finance made",
        type: "per_job",
        start_date: start,
      } as Json,
    });
    expect(insert.error?.code).toBe(PERMISSION_DENIED);
    const update = await finance.client
      .from("contracts")
      .update({ name: "Renamed" })
      .eq("id", id)
      .select();
    expect(update.data ?? []).toEqual([]);
    const rates = await finance.client.rpc("save_draft_rate_card", {
      p_organisation_id: owner.orgId,
      p_contract_id: id,
      p_effective_from: start,
      p_lines: [DAY] as Json,
    });
    expect(rates.error?.code).toBe(PERMISSION_DENIED);
  });

  it("moves a draft's first rate card with its start date, and freezes terms once live", async () => {
    const id = await newContract(ops);
    await saveDraft(id);
    const later = addDays(start, 5);
    const moved = await ops.client.rpc("update_draft_contract", {
      p_organisation_id: owner.orgId,
      p_contract_id: id,
      p_contract: { name: "Apapa guarding", type: "manned_post", start_date: later } as Json,
      p_site_ids: [siteA, siteB],
    });
    expect(moved.error).toBeNull();
    expect((await versions(id))[0]?.effective_from).toBe(later);

    await activate(id);
    const frozen = await owner.client.from("contracts").update({ name: "Renamed" }).eq("id", id);
    expect(frozen.error?.code).toBe("MLCO1");
    const sites = await owner.client.from("contract_sites").delete().eq("contract_id", id).select();
    expect(sites.error?.code).toBe("MLCO3");
    await expect(
      db.query("update public.contracts set client_id = $1 where id = $2", [otherClientId, id]),
    ).rejects.toThrow(/another client/);
    await expect(
      db.query("update public.contracts set status = 'draft' where id = $1", [id]),
    ).rejects.toThrow(/go back/);
    // Ending or shortening a live contract waits for end_contract (2.7).
    const ending = await owner.client
      .from("contracts")
      .update({ end_date: addDays(today, -1) })
      .eq("id", id);
    expect(ending.error?.code).toBe("MLCO1");
  });
});

describe("rate cards", () => {
  it("has no table writes for anyone: only the functions write", async () => {
    const id = await newContract(ops);
    const card = await saveDraft(id);
    const insert = await owner.client.from("rate_cards").insert({
      organisation_id: owner.orgId,
      contract_id: id,
      effective_from: addDays(today, 60),
    });
    expect(insert.error?.code).toBe(PERMISSION_DENIED);
    const update = await owner.client
      .from("rate_card_lines")
      .update({ rate_kobo: 1 })
      .eq("rate_card_id", card);
    expect(update.error?.code).toBe(PERMISSION_DENIED);
    const del = await owner.client.from("rate_cards").delete().eq("id", card);
    expect(del.error?.code).toBe(PERMISSION_DENIED);
  });

  it("saves and replaces a draft card whole, audited with before and after", async () => {
    const id = await newContract(ops);
    const card = await saveDraft(id, [DAY]);
    const again = await saveDraft(id, [DAY, NIGHT]);
    expect(again).toBe(card);
    const { data: lines } = await admin
      .from("rate_card_lines")
      .select("band, rate_kobo::text, ot_rate_kobo::text, currency")
      .eq("rate_card_id", card)
      .order("sort_order");
    expect(lines).toEqual([
      { band: "Day", rate_kobo: "1250000", ot_rate_kobo: null, currency: "NGN" },
      { band: "Night", rate_kobo: "1500000", ot_rate_kobo: "190000", currency: "NGN" },
    ]);
    const audit = await lastAudit(card, "rate_card.draft_saved");
    expect(audit?.actor_id).toBe(ops.id);
    expect(audit?.channel).toBe("web");
    expect(JSON.stringify(audit?.before)).toContain("1250000");
    expect(JSON.stringify(audit?.after)).toContain("1500000");
  });

  it("starts the first rate card on the contract's start date", async () => {
    const id = await newContract(ops);
    const late = await ops.client.rpc("save_draft_rate_card", {
      p_organisation_id: owner.orgId,
      p_contract_id: id,
      p_effective_from: addDays(start, 14),
      p_lines: [DAY] as Json,
    });
    expect(late.error?.code).toBe("MLRC4");
    expect(await versions(id)).toEqual([]);
  });

  it("refuses fractions, floats and duplicate keys in the lines", async () => {
    const id = await newContract(ops);
    for (const lines of [
      [{ ...DAY, rate_kobo: "1250000.5" }],
      [{ ...DAY, rate_kobo: 1250000 }],
      [DAY, { ...DAY, role: "guard", band: "DAY" }],
      [{ ...DAY, rate_kobo: "0" }],
      [],
    ]) {
      const { error } = await ops.client.rpc("save_draft_rate_card", {
        p_organisation_id: owner.orgId,
        p_contract_id: id,
        p_effective_from: start,
        p_lines: lines as Json,
      });
      expect(error, JSON.stringify(lines)).not.toBeNull();
    }
    expect(await versions(id)).toEqual([]);
  });

  it("schedules a change on a draft: the old version closes the day before; cancel reopens it", async () => {
    const id = await newContract(ops);
    const first = await saveDraft(id);
    const from = addDays(today, 43);
    const { data: next, error } = await ops.client.rpc("add_rate_card_version", {
      p_organisation_id: owner.orgId,
      p_contract_id: id,
      p_effective_from: from,
      p_lines: [{ ...DAY, rate_kobo: "1300000" }, NIGHT] as Json,
    });
    expect(error).toBeNull();
    expect(await versions(id)).toEqual([
      { id: first, effective_from: start, effective_to: addDays(from, -1) },
      { id: next, effective_from: from, effective_to: null },
    ]);
    const audit = await lastAudit(next!, "rate_card.version_added");
    expect(audit?.before).toMatchObject({ closes: first, effective_to_after: addDays(from, -1) });

    // A change on or before the scheduled one is an overlap.
    const overlap = await ops.client.rpc("add_rate_card_version", {
      p_organisation_id: owner.orgId,
      p_contract_id: id,
      p_effective_from: addDays(from, -3),
      p_lines: [DAY] as Json,
    });
    expect(overlap.error?.code).toBe("MLRC3");
    // A draft with a change scheduled isn't replaced whole.
    const replace = await ops.client.rpc("save_draft_rate_card", {
      p_organisation_id: owner.orgId,
      p_contract_id: id,
      p_effective_from: start,
      p_lines: [DAY] as Json,
    });
    expect(replace.error?.code).toBe("MLRC3");

    const cancel = await ops.client.rpc("cancel_rate_card_version", {
      p_organisation_id: owner.orgId,
      p_rate_card_id: next!,
    });
    expect(cancel.error).toBeNull();
    expect(await versions(id)).toEqual([{ id: first, effective_from: start, effective_to: null }]);
  });

  it("refuses overlapping versions in the database itself", async () => {
    const id = await newContract(ops);
    await saveDraft(id);
    await expect(
      db.query(
        "insert into public.rate_cards (organisation_id, contract_id, effective_from) values ($1, $2, $3)",
        [owner.orgId, id, addDays(start, 10)],
      ),
    ).rejects.toThrow(/rate_cards_no_overlap/);
    await expect(
      db.query(
        "insert into public.rate_cards (organisation_id, contract_id, effective_from) values ($1, $2, $3)",
        [owner.orgId, id, addDays(start, -1)],
      ),
    ).rejects.toThrow(/inside the contract/);
  });

  describe("on a live contract", () => {
    let id: string;
    let card: string;

    beforeAll(async () => {
      id = await newContract(ops);
      card = await saveDraft(id);
      await activate(id);
    });

    it("refuses editing a version in force, even as the database owner", async () => {
      await expect(
        db.query("update public.rate_card_lines set rate_kobo = 1 where rate_card_id = $1", [card]),
      ).rejects.toThrow(/never edited/);
      await expect(
        db.query("delete from public.rate_card_lines where rate_card_id = $1", [card]),
      ).rejects.toThrow(/already in force/);
      await expect(
        db.query(
          "insert into public.rate_card_lines (organisation_id, rate_card_id, role, unit, rate_kobo) values ($1, $2, 'Supervisor', 'shift', 1)",
          [owner.orgId, card],
        ),
      ).rejects.toThrow(/already in force/);
      await expect(
        db.query("update public.rate_cards set note = 'changed' where id = $1", [card]),
      ).rejects.toThrow(/already in force/);
      await expect(
        db.query("update public.rate_cards set effective_from = effective_from + 1 where id = $1", [
          card,
        ]),
      ).rejects.toThrow(/can't move/);
      await expect(db.query("delete from public.rate_cards where id = $1", [card])).rejects.toThrow(
        /already in force/,
      );
      await expect(
        db.query("update public.rate_cards set effective_to = $1 where id = $2", [
          addDays(today, -5),
          card,
        ]),
      ).rejects.toThrow(/yesterday at the earliest/);
      const save = await ops.client.rpc("save_draft_rate_card", {
        p_organisation_id: owner.orgId,
        p_contract_id: id,
        p_effective_from: start,
        p_lines: [DAY] as Json,
      });
      expect(save.error?.code).toBe("MLRC6");
    });

    it("refuses a backdated change and accepts one from today, closing the old version yesterday", async () => {
      const past = await ops.client.rpc("add_rate_card_version", {
        p_organisation_id: owner.orgId,
        p_contract_id: id,
        p_effective_from: addDays(today, -1),
        p_lines: [DAY, NIGHT] as Json,
      });
      expect(past.error?.code).toBe("MLRC2");
      const { data: next, error } = await ops.client.rpc("add_rate_card_version", {
        p_organisation_id: owner.orgId,
        p_contract_id: id,
        p_effective_from: today,
        p_lines: [{ ...DAY, rate_kobo: "1300000" }, NIGHT] as Json,
      });
      expect(error).toBeNull();
      expect(await versions(id)).toEqual([
        { id: card, effective_from: start, effective_to: addDays(today, -1) },
        { id: next, effective_from: today, effective_to: null },
      ]);
      const { count } = await admin
        .from("rate_card_lines")
        .select("id", { count: "exact", head: true })
        .eq("rate_card_id", next!);
      expect(count).toBe(2);
      // In force from today: it can't be cancelled any more.
      const cancel = await ops.client.rpc("cancel_rate_card_version", {
        p_organisation_id: owner.orgId,
        p_rate_card_id: next!,
      });
      expect(cancel.error?.code).toBe("MLRC1");
    });
  });
});

describe("contract WHT rates", () => {
  it("is written by owner, admin and finance only", async () => {
    const id = await newContract(ops);
    const byOps = await ops.client.rpc("add_contract_wht_rate", {
      p_organisation_id: owner.orgId,
      p_contract_id: id,
      p_rate_bps: 500,
      p_effective_from: start,
    });
    expect(byOps.error?.code).toBe(PERMISSION_DENIED);
    const withWht = await ops.client.rpc("create_contract", {
      p_organisation_id: owner.orgId,
      p_contract: {
        client_id: clientId,
        name: "Ops WHT",
        type: "per_job",
        start_date: start,
      } as Json,
      p_wht_rate_bps: 500,
    });
    expect(withWht.error?.code).toBe(PERMISSION_DENIED);
    const { data: wht, error } = await finance.client.rpc("add_contract_wht_rate", {
      p_organisation_id: owner.orgId,
      p_contract_id: id,
      p_rate_bps: 500,
      p_effective_from: start,
    });
    expect(error).toBeNull();
    expect((await lastAudit(wht!, "contract_wht.rate_added"))?.actor_id).toBe(finance.id);
    const direct = await owner.client
      .from("contract_wht_rates")
      .update({ rate_bps: 0 })
      .eq("id", wht!);
    expect(direct.error?.code).toBe(PERMISSION_DENIED);
  });

  it("dates versions, refuses overlaps and freezes the past once live", async () => {
    const { data: id, error } = await owner.client.rpc("create_contract", {
      p_organisation_id: owner.orgId,
      p_contract: {
        client_id: clientId,
        name: "Owner WHT",
        type: "manned_post",
        start_date: start,
      } as Json,
      p_wht_rate_bps: 500,
    });
    expect(error).toBeNull();
    await activate(id!);
    const { data: rows } = await admin
      .from("contract_wht_rates")
      .select("id, rate_bps, effective_from")
      .eq("contract_id", id!);
    expect(rows?.map((r) => [r.rate_bps, r.effective_from])).toEqual([[500, start]]);
    const firstId = rows![0]!.id;

    await expect(
      db.query("update public.contract_wht_rates set rate_bps = 1000 where id = $1", [firstId]),
    ).rejects.toThrow(/already in force/);
    const past = await finance.client.rpc("add_contract_wht_rate", {
      p_organisation_id: owner.orgId,
      p_contract_id: id!,
      p_rate_bps: 1000,
      p_effective_from: addDays(today, -2),
    });
    expect(past.error?.code).toBe("MLWH2");
    const from = addDays(today, 10);
    const next = await finance.client.rpc("add_contract_wht_rate", {
      p_organisation_id: owner.orgId,
      p_contract_id: id!,
      p_rate_bps: 1000,
      p_effective_from: from,
    });
    expect(next.error).toBeNull();
    const again = await finance.client.rpc("add_contract_wht_rate", {
      p_organisation_id: owner.orgId,
      p_contract_id: id!,
      p_rate_bps: 750,
      p_effective_from: from,
    });
    expect(again.error?.code).toBe("MLWH3");
    const { data: after } = await admin
      .from("contract_wht_rates")
      .select("rate_bps, effective_from, effective_to")
      .eq("contract_id", id!)
      .order("effective_from");
    expect(after).toEqual([
      { rate_bps: 500, effective_from: start, effective_to: addDays(from, -1) },
      { rate_bps: 1000, effective_from: from, effective_to: null },
    ]);
  });
});

describe("another company", () => {
  it("can't read or write contracts, rate cards or WHT through the functions", async () => {
    const id = await newContract(ops);
    const card = await saveDraft(id);
    for (const org of [owner.orgId, other.orgId]) {
      const calls = await Promise.all([
        other.client.rpc("save_draft_rate_card", {
          p_organisation_id: org,
          p_contract_id: id,
          p_effective_from: start,
          p_lines: [DAY] as Json,
        }),
        other.client.rpc("add_rate_card_version", {
          p_organisation_id: org,
          p_contract_id: id,
          p_effective_from: addDays(today, 50),
          p_lines: [DAY] as Json,
        }),
        other.client.rpc("cancel_rate_card_version", {
          p_organisation_id: org,
          p_rate_card_id: card,
        }),
        other.client.rpc("add_contract_wht_rate", {
          p_organisation_id: org,
          p_contract_id: id,
          p_rate_bps: 500,
          p_effective_from: start,
        }),
        other.client.rpc("update_draft_contract", {
          p_organisation_id: org,
          p_contract_id: id,
          p_contract: { name: "Hijack", type: "per_job", start_date: start } as Json,
        }),
      ]);
      for (const call of calls) {
        expect(call.error, org).not.toBeNull();
        expect([PERMISSION_DENIED, "P0002"]).toContain(call.error?.code);
      }
    }
    expect(await versions(id)).toHaveLength(1);
    const { data } = await admin.from("contracts").select("name").eq("id", id).single();
    expect(data?.name).toBe("Apapa guarding");
    const read = await other.client.from("rate_card_lines").select("id").eq("rate_card_id", card);
    expect(read.data).toEqual([]);
  });
});
