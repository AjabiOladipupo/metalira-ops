/**
 * Slice 4.1: company calendar and leave setup. HR (owner, admin) write through the SQL functions;
 * line managers and workers read leave types only; holidays are kept when removed; entitlement
 * versions never overlap and a version in force never changes (rule 3); the database's presets
 * match src/lib/leave/presets.ts.
 */
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays, lagosToday } from "@/lib/dates";
import { PRESETS } from "@/lib/leave/presets";

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
const year = Number(today.slice(0, 4));
const nextJanuary = `${year + 1}-01-01`;
const tomorrow = addDays(today, 1);

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
let hr: TestUser;
let lineManager: TestUser;
let worker: TestUser;

async function join(user: TestUser, role: "hr" | "line_manager" | "worker") {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: owner.orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

async function typeId(code: string): Promise<string> {
  const { data, error } = await admin
    .from("leave_types")
    .select("id")
    .eq("organisation_id", owner.orgId)
    .eq("code", code)
    .single();
  if (error) throw new Error(error.message);
  return data.id;
}

async function versions(leaveTypeId: string) {
  const { data, error } = await admin
    .from("leave_entitlements")
    .select("id, effective_from, effective_to, days_per_year, pay_percent")
    .eq("leave_type_id", leaveTypeId)
    .order("effective_from");
  if (error) throw new Error(error.message);
  return data;
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("leave-owner", "Leave Setup Org");
  other = await createTenantUser("leave-other", "Other Leave Org");
  hr = await createTestUser("leave-hr");
  lineManager = await createTestUser("leave-lm");
  worker = await createTestUser("leave-worker");
  await join(hr, "hr");
  await join(lineManager, "line_manager");
  await join(worker, "worker");
});

afterAll(async () => {
  await db?.end();
});

describe("presets", () => {
  it("match src/lib/leave/presets.ts in the database", async () => {
    for (const preset of PRESETS) {
      const { rows } = await db.query(
        "select * from private.leave_preset_rows($1)",
        [preset.id],
      );
      expect(rows).toEqual(
        preset.types.map((t) => ({
          code: t.code,
          name: t.name,
          counting: t.counting,
          paid: t.paid,
          needs_certificate: t.needsCertificate,
          min_service_months: t.minServiceMonths,
          days_per_year: t.daysPerYear,
          pay_percent: t.payPercent,
          pay_min_service_months: t.payMinServiceMonths,
          source_label: t.sourceLabel,
        })),
      );
    }
    const { rows } = await db.query("select count(*)::int as n from private.leave_preset_rows('C')");
    expect(rows[0].n).toBe(0);
  });

  it("refuses preset C and roles other than owner, admin and hr", async () => {
    const c = await hr.client.rpc("apply_leave_preset", {
      p_organisation_id: owner.orgId,
      p_preset: "C",
      p_dry_run: true,
    });
    expect(c.error?.code).toBe("22023");
    for (const caller of [lineManager, worker, other]) {
      const { error } = await caller.client.rpc("apply_leave_preset", {
        p_organisation_id: owner.orgId,
        p_preset: "B",
        p_dry_run: true,
      });
      expect(error?.code).toBe(PERMISSION_DENIED);
    }
  });

  it("previews without writing, then applies preset B", async () => {
    const dry = await hr.client.rpc("apply_leave_preset", {
      p_organisation_id: owner.orgId,
      p_preset: "B",
      p_dry_run: true,
    });
    expect(dry.error).toBeNull();
    const preview = dry.data as { types: { code: string; action: string }[] };
    expect(preview.types.map((t) => [t.code, t.action])).toEqual([
      ["annual", "create"],
      ["sick", "create"],
      ["maternity", "create"],
      ["paternity", "create"],
      ["compassionate", "create"],
    ]);
    const none = await admin
      .from("leave_types")
      .select("id", { count: "exact", head: true })
      .eq("organisation_id", owner.orgId);
    expect(none.count).toBe(0);

    const applied = await hr.client.rpc("apply_leave_preset", {
      p_organisation_id: owner.orgId,
      p_preset: "B",
    });
    expect(applied.error).toBeNull();
    const annual = await versions(await typeId("annual"));
    expect(annual).toEqual([
      expect.objectContaining({ effective_from: `${year}-01-01`, effective_to: null, days_per_year: 15 }),
    ]);

    const log = await admin
      .from("audit_log")
      .select("action")
      .eq("organisation_id", owner.orgId)
      .eq("action", "leave.preset_applied");
    expect(log.data).toHaveLength(1);
  });

  it("versions existing types from the next 1 January when preset A is applied, keeping the rest", async () => {
    const { data, error } = await owner.client.rpc("apply_leave_preset", {
      p_organisation_id: owner.orgId,
      p_preset: "A",
    });
    expect(error).toBeNull();
    const result = data as { types: { code: string; action: string }[]; kept: { code: string }[] };
    expect(result.types.map((t) => [t.code, t.action])).toEqual([
      ["annual", "version"],
      ["sick", "unchanged"],
      ["maternity", "version"],
    ]);
    expect(result.kept.map((k) => k.code).sort()).toEqual(["compassionate", "paternity"]);
    const annual = await versions(await typeId("annual"));
    expect(annual).toEqual([
      expect.objectContaining({ days_per_year: 15, effective_to: `${year}-12-31` }),
      expect.objectContaining({ days_per_year: 6, effective_from: nextJanuary, effective_to: null }),
    ]);
    const maternity = await versions(await typeId("maternity"));
    expect(maternity.at(-1)).toMatchObject({ pay_percent: 50 });
    const types = await admin
      .from("leave_types")
      .select("code, min_service_months, preset")
      .eq("organisation_id", owner.orgId)
      .eq("code", "annual")
      .single();
    expect(types.data).toMatchObject({ min_service_months: 12, preset: "A" });
  });
});

describe("entitlement versions", () => {
  it("replaces a scheduled version and refuses a change from today", async () => {
    const annual = await typeId("annual");
    const refused = await hr.client.rpc("add_leave_entitlement_version", {
      p_organisation_id: owner.orgId,
      p_leave_type_id: annual,
      p_from: today,
      p_days_per_year: 18,
      p_pay_percent: 100,
    });
    expect(refused.error?.code).toBe("MLLV1");

    const { error } = await hr.client.rpc("add_leave_entitlement_version", {
      p_organisation_id: owner.orgId,
      p_leave_type_id: annual,
      p_from: nextJanuary,
      p_days_per_year: 18,
      p_pay_percent: 100,
    });
    expect(error).toBeNull();
    const rows = await versions(annual);
    expect(rows.map((r) => [r.effective_from, r.days_per_year])).toEqual([
      [`${year}-01-01`, 15],
      [nextJanuary, 18],
    ]);

    const fromTomorrow = await hr.client.rpc("add_leave_entitlement_version", {
      p_organisation_id: owner.orgId,
      p_leave_type_id: annual,
      p_from: tomorrow,
      p_days_per_year: 16,
      p_pay_percent: 100,
    });
    expect(fromTomorrow.error).toBeNull();
    const after = await versions(annual);
    expect(after.map((r) => [r.effective_from, r.effective_to, r.days_per_year])).toEqual([
      [`${year}-01-01`, today, 15],
      [tomorrow, null, 16],
    ]);
  });

  it("lets line managers and workers read types and versions but write nothing", async () => {
    for (const reader of [lineManager, worker]) {
      const types = await reader.client.from("leave_types").select("id").eq("organisation_id", owner.orgId);
      expect(types.error).toBeNull();
      expect(types.data!.length).toBeGreaterThanOrEqual(5);
      const ents = await reader.client
        .from("leave_entitlements")
        .select("id")
        .eq("organisation_id", owner.orgId);
      expect(ents.data!.length).toBeGreaterThan(0);
      const write = await reader.client.rpc("add_leave_entitlement_version", {
        p_organisation_id: owner.orgId,
        p_leave_type_id: await typeId("sick"),
        p_from: nextJanuary,
        p_days_per_year: 20,
        p_pay_percent: 100,
      });
      expect(write.error?.code).toBe(PERMISSION_DENIED);
      const save = await reader.client.rpc("save_leave_type", {
        p_organisation_id: owner.orgId,
        p_name: "Casual",
        p_counting: "working_days",
        p_paid: true,
        p_needs_certificate: false,
        p_min_service_months: 0,
        p_status: "active",
        p_days_per_year: 3,
      });
      expect(save.error?.code).toBe(PERMISSION_DENIED);
    }
  });

  it("never changes a version in force, even for the database owner", async () => {
    const [inForce] = await versions(await typeId("sick"));
    await expect(
      db.query("update public.leave_entitlements set days_per_year = 30 where id = $1", [inForce!.id]),
    ).rejects.toMatchObject({ code: "MLLV2" });
    await expect(
      db.query("delete from public.leave_entitlements where id = $1", [inForce!.id]),
    ).rejects.toMatchObject({ code: "MLLV2" });
    await expect(
      db.query("update public.leave_entitlements set effective_to = $2 where id = $1", [
        inForce!.id,
        addDays(today, -2),
      ]),
    ).rejects.toMatchObject({ code: "MLLV2" });
  });

  it("never extends or reopens a version in force, even for the database owner", async () => {
    // Annual's version in force was closed today by the change from tomorrow above.
    const [inForce] = await versions(await typeId("annual"));
    expect(inForce!.effective_to).toBe(today);
    for (const to of [null, addDays(today, 1), `${year + 3}-12-31`]) {
      await expect(
        db.query("update public.leave_entitlements set effective_to = $2 where id = $1", [
          inForce!.id,
          to,
        ]),
      ).rejects.toMatchObject({ code: "MLLV2" });
    }
    // An open-ended version in force can't be reopened once closed, nor closed before today.
    const [sick] = await versions(await typeId("sick"));
    expect(sick!.effective_to).toBeNull();
    await expect(
      db.query("update public.leave_entitlements set effective_to = $2 where id = $1", [
        sick!.id,
        addDays(today, -1),
      ]),
    ).rejects.toMatchObject({ code: "MLLV2" });
    expect((await versions(await typeId("annual")))[0]!.effective_to).toBe(today);
  });

  it("refuses overlapping versions", async () => {
    const sick = await typeId("sick");
    await expect(
      db.query(
        `insert into public.leave_entitlements (organisation_id, leave_type_id, effective_from, days_per_year)
         values ($1, $2, $3, 10)`,
        [owner.orgId, sick, `${year + 5}-01-01`],
      ),
    ).rejects.toMatchObject({ code: "23P01" });
  });

  it("creates the company's own type with a first version, and retires without deleting", async () => {
    const { data: id, error } = await hr.client.rpc("save_leave_type", {
      p_organisation_id: owner.orgId,
      p_name: "Casual",
      p_counting: "working_days",
      p_paid: true,
      p_needs_certificate: false,
      p_min_service_months: 0,
      p_status: "active",
      p_days_per_year: 3,
    });
    expect(error).toBeNull();
    expect(await versions(id!)).toEqual([
      expect.objectContaining({ effective_from: `${year}-01-01`, days_per_year: 3 }),
    ]);
    const dup = await hr.client.rpc("save_leave_type", {
      p_organisation_id: owner.orgId,
      p_name: "casual",
      p_counting: "working_days",
      p_paid: true,
      p_needs_certificate: false,
      p_min_service_months: 0,
      p_status: "active",
      p_days_per_year: 3,
    });
    expect(dup.error?.code).toBe("MLLV5");
    const retire = await hr.client.rpc("save_leave_type", {
      p_organisation_id: owner.orgId,
      p_leave_type_id: id!,
      p_name: "Casual",
      p_counting: "working_days",
      p_paid: true,
      p_needs_certificate: false,
      p_min_service_months: 0,
      p_status: "retired",
    });
    expect(retire.error).toBeNull();
    await expect(db.query("delete from public.leave_types where id = $1", [id])).rejects.toMatchObject(
      { code: "MLLV3" },
    );
  });
});

describe("paid and pay percent", () => {
  async function saveCompassionate(paid: boolean) {
    const { error } = await hr.client.rpc("save_leave_type", {
      p_organisation_id: owner.orgId,
      p_leave_type_id: await typeId("compassionate"),
      p_name: "Compassionate",
      p_counting: "working_days",
      p_paid: paid,
      p_needs_certificate: false,
      p_min_service_months: 0,
      p_status: "active",
    });
    expect(error).toBeNull();
  }

  /** The paid flag and the pay of the version in force from tomorrow on. */
  async function flagAndPay() {
    const id = await typeId("compassionate");
    const type = await admin.from("leave_types").select("paid").eq("id", id).single();
    const rows = await versions(id);
    const fromTomorrow = rows.find(
      (r) => r.effective_from <= tomorrow && (r.effective_to === null || r.effective_to >= tomorrow),
    );
    return { paid: type.data!.paid, pay: fromTomorrow!.pay_percent, latest: rows.at(-1)! };
  }

  it("changes the pay with the paid flag, so they never disagree", async () => {
    await saveCompassionate(false);
    let now = await flagAndPay();
    expect(now).toMatchObject({ paid: false, pay: 0 });
    expect(now.latest).toMatchObject({ effective_from: tomorrow, effective_to: null, days_per_year: 3 });

    await saveCompassionate(true);
    now = await flagAndPay();
    expect(now).toMatchObject({ paid: true, pay: 100 });

    // Every type: an unpaid type pays 0 and a paid one more than 0 from tomorrow on.
    const types = await admin
      .from("leave_types")
      .select("id, paid")
      .eq("organisation_id", owner.orgId)
      .eq("status", "active");
    for (const t of types.data!) {
      const rows = await versions(t.id);
      const v = rows.find(
        (r) => r.effective_from <= tomorrow && (r.effective_to === null || r.effective_to >= tomorrow),
      );
      expect(v!.pay_percent > 0, t.id).toBe(t.paid);
    }
  });

  it("refuses pay on an unpaid type", async () => {
    await saveCompassionate(false);
    const { error } = await hr.client.rpc("add_leave_entitlement_version", {
      p_organisation_id: owner.orgId,
      p_leave_type_id: await typeId("compassionate"),
      p_from: nextJanuary,
      p_days_per_year: 3,
      p_pay_percent: 100,
    });
    expect(error?.code).toBe("22023");
    await saveCompassionate(true);
  });
});

describe("holidays and the working week", () => {
  it("adds, refuses a second holiday on a date, and keeps a removed one", async () => {
    const date = `${year}-10-01`;
    const { data: id, error } = await hr.client.rpc("add_public_holiday", {
      p_organisation_id: owner.orgId,
      p_date: date,
      p_name: "Independence Day",
    });
    expect(error).toBeNull();
    const again = await hr.client.rpc("add_public_holiday", {
      p_organisation_id: owner.orgId,
      p_date: date,
      p_name: "Independence",
    });
    expect(again.error?.code).toBe("MLHD1");

    const removed = await hr.client.rpc("remove_public_holiday", {
      p_organisation_id: owner.orgId,
      p_holiday_id: id!,
    });
    expect(removed.error).toBeNull();
    const row = await admin.from("public_holidays").select("removed_at, removed_by").eq("id", id!).single();
    expect(row.data?.removed_at).not.toBeNull();
    expect(row.data?.removed_by).toBe(hr.id);
    await expect(db.query("delete from public.public_holidays where id = $1", [id])).rejects.toMatchObject(
      { code: "MLHD2" },
    );

    const readded = await hr.client.rpc("add_public_holiday", {
      p_organisation_id: owner.orgId,
      p_date: date,
      p_name: "Independence Day",
    });
    expect(readded.error).toBeNull();
  });

  it("copies a year after a dry run that writes nothing", async () => {
    const dry = await hr.client.rpc("copy_public_holidays", {
      p_organisation_id: owner.orgId,
      p_from_year: year,
      p_to_year: year + 1,
      p_dry_run: true,
    });
    expect(dry.error).toBeNull();
    expect((dry.data as { copied: unknown[] }).copied).toHaveLength(1);
    const before = await admin
      .from("public_holidays")
      .select("id", { count: "exact", head: true })
      .eq("organisation_id", owner.orgId)
      .eq("holiday_date", `${year + 1}-10-01`);
    expect(before.count).toBe(0);

    const real = await hr.client.rpc("copy_public_holidays", {
      p_organisation_id: owner.orgId,
      p_from_year: year,
      p_to_year: year + 1,
    });
    expect(real.error).toBeNull();
    const second = await hr.client.rpc("copy_public_holidays", {
      p_organisation_id: owner.orgId,
      p_from_year: year,
      p_to_year: year + 1,
      p_dry_run: true,
    });
    expect((second.data as { skipped: unknown[] }).skipped).toHaveLength(1);
  });

  it("shows holidays to managers but not to workers or another company", async () => {
    const lm = await lineManager.client
      .from("public_holidays")
      .select("id")
      .eq("organisation_id", owner.orgId);
    expect(lm.data!.length).toBeGreaterThan(0);
    for (const reader of [worker, other]) {
      const { data } = await reader.client
        .from("public_holidays")
        .select("id")
        .eq("organisation_id", owner.orgId);
      expect(data).toEqual([]);
    }
    const add = await lineManager.client.rpc("add_public_holiday", {
      p_organisation_id: owner.orgId,
      p_date: `${year}-12-25`,
      p_name: "Christmas Day",
    });
    expect(add.error?.code).toBe(PERMISSION_DENIED);
  });

  it("sets the working week for hr and refuses an empty one", async () => {
    const { data, error } = await hr.client.rpc("set_work_week", {
      p_organisation_id: owner.orgId,
      p_days: [6, 1, 2, 3, 4, 5],
    });
    expect(error).toBeNull();
    expect(data).toEqual([1, 2, 3, 4, 5, 6]);
    const empty = await hr.client.rpc("set_work_week", { p_organisation_id: owner.orgId, p_days: [] });
    expect(empty.error?.code).toBe("22023");
    const lm = await lineManager.client.rpc("set_work_week", {
      p_organisation_id: owner.orgId,
      p_days: [1],
    });
    expect(lm.error?.code).toBe(PERMISSION_DENIED);
  });
});
