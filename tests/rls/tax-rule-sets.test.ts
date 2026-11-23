/**
 * Slice 5.0: tax rule sets. Owner, hr and finance read; owner and hr add dated versions through
 * the SQL functions; only an owner records the tax adviser's confirmation; admins, ops managers,
 * line managers, workers and other companies see and do nothing. A version in force never
 * changes, for the secret key and the database owner too (rule 3); versions never overlap; the
 * database's template equals src/lib/payroll/rule-set.ts NTA_2025_V1 (which a unit test compares
 * with docs/RULES_NIGERIA.md).
 */
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays, lagosToday } from "@/lib/dates";
import {
  NTA_2025_V1,
  NTA_2025_V1_SOURCE,
  ruleSetPolicyJson,
  ruleSetRulesJson,
} from "@/lib/payroll/rule-set";

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

const today = lagosToday();
const tomorrow = addDays(today, 1);
const year = Number(today.slice(0, 4));
const rules = ruleSetRulesJson(NTA_2025_V1.rules);
const policy = ruleSetPolicyJson(NTA_2025_V1.policy);

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
let hr: TestUser;
let finance: TestUser;
let adminUser: TestUser;
let opsManager: TestUser;
let lineManager: TestUser;
let worker: TestUser;

async function join(
  user: TestUser,
  role: "hr" | "finance" | "admin" | "ops_manager" | "line_manager" | "worker",
) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: owner.orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

async function versions(orgId = owner.orgId) {
  const { data, error } = await admin
    .from("tax_rule_sets")
    .select("id, name, effective_from, effective_to, rules, adviser_confirmed_at, adviser_note")
    .eq("organisation_id", orgId)
    .order("effective_from");
  if (error) throw new Error(error.message);
  return data;
}

function withNsitf(bps: number) {
  return { ...rules, nsitf: { rate_bps: bps } };
}

function addArgs(over: Record<string, unknown> = {}) {
  return {
    p_organisation_id: owner.orgId,
    p_name: "NTA 2025 v2",
    p_rules: withNsitf(150),
    p_policy: policy,
    p_effective_from: tomorrow,
    p_reason: "Adviser's advice",
    ...over,
  };
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("rules-owner", "Payroll Rules Org");
  other = await createTenantUser("rules-other", "Other Rules Org");
  hr = await createTestUser("rules-hr");
  finance = await createTestUser("rules-finance");
  adminUser = await createTestUser("rules-admin");
  opsManager = await createTestUser("rules-ops");
  lineManager = await createTestUser("rules-lm");
  worker = await createTestUser("rules-worker");
  await join(hr, "hr");
  await join(finance, "finance");
  await join(adminUser, "admin");
  await join(opsManager, "ops_manager");
  await join(lineManager, "line_manager");
  await join(worker, "worker");
});

afterAll(async () => {
  await db?.end();
});

describe("the template", () => {
  it("equals src/lib/payroll/rule-set.ts NTA_2025_V1", async () => {
    const { rows } = await db.query(
      "select name, effective_from::text as effective_from, rules, policy, source_label from private.tax_rule_set_template()",
    );
    expect(rows).toEqual([
      {
        name: NTA_2025_V1.name,
        effective_from: "2026-01-01",
        rules,
        policy,
        source_label: NTA_2025_V1_SOURCE,
      },
    ]);
    const valid = await db.query(
      "select private.tax_rules_valid(t.rules) as r, private.tax_policy_valid(t.policy) as p from private.tax_rule_set_template() t",
    );
    expect(valid.rows[0]).toEqual({ r: true, p: true });
  });

  it("is copied once on first use, by hr, from 1 Jan 2026", async () => {
    expect(await versions()).toEqual([]);
    const first = await hr.client.rpc("ensure_tax_rule_set", { p_organisation_id: owner.orgId });
    expect(first.error).toBeNull();
    const again = await hr.client.rpc("ensure_tax_rule_set", { p_organisation_id: owner.orgId });
    expect(again.data).toBe(first.data);
    const rows = await versions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.data,
      name: "NTA 2025 v1",
      effective_from: "2026-01-01",
      effective_to: null,
      rules,
      adviser_confirmed_at: null,
    });
  });

  it("refuses other roles and companies, and lets the secret key ensure", async () => {
    for (const caller of [finance, adminUser, opsManager, lineManager, worker, other]) {
      const { error } = await caller.client.rpc("ensure_tax_rule_set", {
        p_organisation_id: owner.orgId,
      });
      expect(error?.code).toBe(PERMISSION_DENIED);
    }
    const { data, error } = await admin.rpc("ensure_tax_rule_set", {
      p_organisation_id: other.orgId,
    });
    expect(error).toBeNull();
    expect(data).toBeTruthy();
    expect(await versions(other.orgId)).toHaveLength(1);
  });
});

describe("who reads", () => {
  it("owner, hr and finance read; nobody else does", async () => {
    for (const reader of [owner, hr, finance]) {
      const { data, error } = await reader.client
        .from("tax_rule_sets")
        .select("id")
        .eq("organisation_id", owner.orgId);
      expect(error).toBeNull();
      expect(data!.length).toBeGreaterThan(0);
    }
    for (const outsider of [adminUser, opsManager, lineManager, worker, other]) {
      const { data } = await outsider.client
        .from("tax_rule_sets")
        .select("id")
        .eq("organisation_id", owner.orgId);
      expect(data ?? []).toEqual([]);
    }
  });

  it("no signed-in role writes the table directly", async () => {
    const [v] = await versions();
    for (const caller of [owner, hr]) {
      await caller.client.from("tax_rule_sets").update({ name: "Changed" }).eq("id", v!.id);
      const ins = await caller.client.from("tax_rule_sets").insert({
        organisation_id: owner.orgId,
        name: "Direct",
        effective_from: `${year + 5}-01-01`,
        rules,
        policy,
        reason: "Direct",
      });
      expect(ins.error).not.toBeNull();
    }
    expect((await versions())[0]!.name).toBe("NTA 2025 v1");
  });
});

describe("adding a version", () => {
  it("refuses finance, admins, line managers, workers and other companies", async () => {
    for (const caller of [finance, adminUser, opsManager, lineManager, worker, other]) {
      const { error } = await caller.client.rpc("add_tax_rule_set_version", {
        ...addArgs(),
        p_dry_run: true,
      });
      expect(error?.code).toBe(PERMISSION_DENIED);
    }
  });

  it("refuses a start of today or earlier, and bad figures", async () => {
    for (const from of [today, addDays(today, -30)]) {
      const { error } = await hr.client.rpc(
        "add_tax_rule_set_version",
        addArgs({ p_effective_from: from }),
      );
      expect(error?.code).toBe("MLPR7");
    }
    const bad = [
      { p_rules: { ...rules, nsitf: { rate_bps: 10_001 } } },
      { p_rules: { ...rules, paye_bands: rules.paye_bands.slice(0, 5) } },
      { p_rules: { ...rules, extra: true } },
      { p_policy: { ...policy, overtime_multiplier_bps: 9_000 } },
      { p_reason: " " },
      { p_name: "see https://x.example" },
    ];
    for (const over of bad) {
      const { error } = await hr.client.rpc("add_tax_rule_set_version", addArgs(over));
      expect(error?.code, JSON.stringify(over)).toBe("22023");
    }
    expect(await versions()).toHaveLength(1);
  });

  it("previews without writing, then adds from tomorrow and closes today's version today", async () => {
    const dry = await hr.client.rpc("add_tax_rule_set_version", { ...addArgs(), p_dry_run: true });
    expect(dry.error).toBeNull();
    expect(dry.data).toMatchObject({
      dry_run: true,
      unchanged: false,
      effective_from: tomorrow,
      replaces: [],
    });
    expect((dry.data as { before: { name: string } }).before.name).toBe("NTA 2025 v1");
    expect(await versions()).toHaveLength(1);

    const { error } = await hr.client.rpc("add_tax_rule_set_version", addArgs());
    expect(error).toBeNull();
    const rows = await versions();
    expect(rows.map((r) => [r.name, r.effective_from, r.effective_to])).toEqual([
      ["NTA 2025 v1", "2026-01-01", today],
      ["NTA 2025 v2", tomorrow, null],
    ]);
    const { data: audit } = await admin
      .from("audit_log")
      .select("action, reason")
      .eq("organisation_id", owner.orgId)
      .eq("action", "payroll.rule_set_version_added");
    expect(audit).toEqual([
      { action: "payroll.rule_set_version_added", reason: "Adviser's advice" },
    ]);
  });

  it("replaces a scheduled version and changes nothing when the figures are the same", async () => {
    const later = `${year + 1}-03-01`;
    const a = await owner.client.rpc(
      "add_tax_rule_set_version",
      addArgs({ p_name: "NTA 2025 v3", p_effective_from: later, p_rules: withNsitf(175) }),
    );
    expect(a.error).toBeNull();
    const same = await owner.client.rpc(
      "add_tax_rule_set_version",
      addArgs({ p_name: "Same", p_effective_from: `${year + 1}-06-01`, p_rules: withNsitf(175) }),
    );
    expect(same.data).toMatchObject({ unchanged: true, id: null });
    const b = await owner.client.rpc(
      "add_tax_rule_set_version",
      addArgs({
        p_name: "NTA 2025 v4",
        p_effective_from: `${year + 1}-02-01`,
        p_rules: withNsitf(200),
      }),
    );
    expect(b.error).toBeNull();
    expect((b.data as { replaces: { name: string }[] }).replaces.map((r) => r.name)).toEqual([
      "NTA 2025 v3",
    ]);
    const rows = await versions();
    expect(rows.map((r) => [r.name, r.effective_from, r.effective_to])).toEqual([
      ["NTA 2025 v1", "2026-01-01", today],
      ["NTA 2025 v2", tomorrow, `${year + 1}-01-31`],
      ["NTA 2025 v4", `${year + 1}-02-01`, null],
    ]);
  });
});

describe("the dated-version guard", () => {
  it("never changes a version in force, even for the database owner and the secret key", async () => {
    const [inForce] = await versions();
    await expect(
      db.query(
        "update public.tax_rule_sets set rules = jsonb_set(rules, '{nsitf,rate_bps}', '200') where id = $1",
        [inForce!.id],
      ),
    ).rejects.toMatchObject({ code: "MLPR8" });
    await expect(
      db.query("update public.tax_rule_sets set name = 'Renamed' where id = $1", [inForce!.id]),
    ).rejects.toMatchObject({
      code: "MLPR8",
    });
    await expect(
      db.query("delete from public.tax_rule_sets where id = $1", [inForce!.id]),
    ).rejects.toMatchObject({
      code: "MLPR8",
    });
    await expect(db.query("truncate public.tax_rule_sets")).rejects.toMatchObject({
      code: "MLPR8",
    });
    const viaKey = await admin
      .from("tax_rule_sets")
      .update({ name: "Renamed" })
      .eq("id", inForce!.id);
    expect(viaKey.error?.code).toBe("MLPR8");
    const deleteViaKey = await admin.from("tax_rule_sets").delete().eq("id", inForce!.id);
    expect(deleteViaKey.error?.code).toBe("MLPR8");
  });

  it("never reopens or extends a closed version, nor closes one before today", async () => {
    const [closed] = await versions();
    expect(closed!.effective_to).toBe(today);
    for (const to of [null, tomorrow, addDays(today, -1)]) {
      await expect(
        db.query("update public.tax_rule_sets set effective_to = $2 where id = $1", [
          closed!.id,
          to,
        ]),
      ).rejects.toMatchObject({ code: "MLPR8" });
    }
  });

  it("refuses overlapping versions and a backdated insert", async () => {
    await expect(
      db.query(
        `insert into public.tax_rule_sets (organisation_id, name, effective_from, rules, policy, reason)
         values ($1, 'Overlap', $2, $3, $4, 'x')`,
        [owner.orgId, `${year + 3}-01-01`, rules, policy],
      ),
    ).rejects.toMatchObject({ code: "23P01" });
    await expect(
      db.query(
        `insert into public.tax_rule_sets (organisation_id, name, effective_from, rules, policy, reason)
         values ($1, 'Backdated', '2026-02-01', $2, $3, 'x')`,
        [owner.orgId, rules, policy],
      ),
    ).rejects.toMatchObject({ code: "MLPR7" });
  });

  it("refuses a bad shape even from the database owner", async () => {
    await expect(
      db.query(
        "insert into public.tax_rule_sets (organisation_id, name, effective_from, rules, policy, reason) values ($1, 'Bad', '2026-01-01', '{}'::jsonb, $2, 'x')",
        [other.orgId, policy],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("the adviser's confirmation", () => {
  it("is recorded by an owner only, once, and then kept", async () => {
    const [v1] = await versions();
    for (const caller of [hr, finance, adminUser, lineManager, other]) {
      const { error } = await caller.client.rpc("confirm_tax_rule_set", {
        p_organisation_id: owner.orgId,
        p_rule_set_id: v1!.id,
        p_note: "Confirmed",
      });
      expect(error?.code).toBe(PERMISSION_DENIED);
    }
    const blank = await owner.client.rpc("confirm_tax_rule_set", {
      p_organisation_id: owner.orgId,
      p_rule_set_id: v1!.id,
      p_note: " ",
    });
    expect(blank.error?.code).toBe("22023");
    const ok = await owner.client.rpc("confirm_tax_rule_set", {
      p_organisation_id: owner.orgId,
      p_rule_set_id: v1!.id,
      p_note: "Confirmed by our tax adviser on 2 Dec 2026",
    });
    expect(ok.error).toBeNull();
    const again = await owner.client.rpc("confirm_tax_rule_set", {
      p_organisation_id: owner.orgId,
      p_rule_set_id: v1!.id,
      p_note: "Again",
    });
    expect(again.error?.code).toBe("MLPR9");
    const [after] = await versions();
    expect(after!.adviser_note).toBe("Confirmed by our tax adviser on 2 Dec 2026");
    expect(after!.adviser_confirmed_at).not.toBeNull();
    await expect(
      db.query("update public.tax_rule_sets set adviser_note = 'Changed' where id = $1", [v1!.id]),
    ).rejects.toMatchObject({ code: "MLPR9" });
    await expect(
      db.query(
        "update public.tax_rule_sets set adviser_confirmed_at = null, adviser_confirmed_by = null, adviser_note = null where id = $1",
        [v1!.id],
      ),
    ).rejects.toMatchObject({ code: "MLPR9" });
  });

  it("refuses another company's version", async () => {
    const [theirs] = await versions(other.orgId);
    const { error } = await owner.client.rpc("confirm_tax_rule_set", {
      p_organisation_id: owner.orgId,
      p_rule_set_id: theirs!.id,
      p_note: "Confirmed",
    });
    expect(error?.code).toBe("P0002");
  });
});
