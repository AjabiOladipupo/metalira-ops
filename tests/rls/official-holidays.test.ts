/**
 * Slice 5.9b: the official holiday calendar and the statutory due dates (migration
 * 20261122240000) against the real database.
 * - A deliberate tenancy exception: public.official_holidays has no organisation_id. Every
 *   signed-in user reads it; nobody signed in writes it (isolation.test.ts proves that as a
 *   platform table); anon reads nothing.
 * - Insert-only for everyone (rule 4): the secret key may insert a holiday or a withdrawal, but
 *   neither the secret key nor the database owner can update, delete or truncate, even in replica
 *   mode (ENABLE ALWAYS); a wrong date is withdrawn with a reason, once.
 * - The SQL due dates (private.statutory_deadline, private.statutory_due_date) agree with
 *   src/lib/payroll/statutory.ts on the same calendar, a state's holiday moves only its own PAYE,
 *   and a withdrawn holiday stops counting.
 */
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  officialCalendar,
  remittanceDeadline,
  statutoryDeadline,
  deadlineHolidays,
  type RemittanceKind,
} from "@/lib/payroll/statutory";

import {
  adminClient,
  anonClient,
  createTenantUser,
  pgClient,
  type Client,
  type TenantUser,
} from "./helpers/supabase";

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("oh-owner", "Official Holidays Org");
  other = await createTenantUser("oh-other", "Other Official Holidays Org");
});

afterAll(async () => {
  await db?.end();
});

async function standingCalendar() {
  const { rows } = await db.query<{
    date: string;
    scope: "federal" | "state";
    state_key: string | null;
  }>(
    `select h.holiday_date::text as date, h.scope, h.state_key
     from public.official_holidays h
     where h.entry = 'holiday'
       and not exists (select 1 from public.official_holidays w where w.withdraws_id = h.id)`,
  );
  return officialCalendar(
    rows.map((r) => ({ date: r.date, scope: r.scope, stateKey: r.state_key })),
  );
}

async function sqlDeadline(kind: RemittanceKind, paidOn: string, state: string | null) {
  const { rows } = await db.query<{ d: string }>(
    "select private.statutory_deadline($1, $2::date, $3)::text as d",
    [kind, paidOn, state],
  );
  return rows[0]!.d;
}

describe("reading the calendar", () => {
  it("is seeded with the federal holidays, read alike by every company", async () => {
    for (const me of [owner, other]) {
      const { data, error } = await me.client
        .from("official_holidays")
        .select("holiday_date, name, scope")
        .eq("entry", "holiday")
        .gte("holiday_date", "2026-01-01")
        .lte("holiday_date", "2026-12-31")
        .order("holiday_date");
      expect(error).toBeNull();
      expect(data!.map((h) => h.holiday_date)).toEqual(
        expect.arrayContaining(["2026-01-01", "2026-06-12", "2026-10-01", "2026-12-25"]),
      );
      expect(data!.every((h) => h.scope === "federal")).toBe(true);
    }
  });

  it("gives anon nothing", async () => {
    const { data, error } = await anonClient().from("official_holidays").select("id");
    if (error) expect(error.code).toBe("42501");
    else expect(data).toEqual([]);
  });
});

describe("kept as written", () => {
  it("lets the secret key add and withdraw, never change or remove", async () => {
    const added = await admin
      .from("official_holidays")
      .insert({
        entry: "holiday",
        holiday_date: "2030-05-10",
        name: "Test state day",
        scope: "state",
        state_key: "kano",
        source: "Test",
        recorded_by: "rls test",
      })
      .select("id")
      .single();
    expect(added.error).toBeNull();
    const id = added.data!.id;
    // A second standing holiday for the same day, scope and state is refused.
    const twice = await admin.from("official_holidays").insert({
      entry: "holiday",
      holiday_date: "2030-05-10",
      name: "Again",
      scope: "state",
      state_key: "kano",
      source: "Test",
      recorded_by: "rls test",
    });
    expect(twice.error?.code).toBe("MLDD4");
    // A state that isn't one of the 36 or FCT, or isn't a normalised key, is refused.
    for (const state_key of ["atlantis", "Kano", "kano state"]) {
      const bad = await admin.from("official_holidays").insert({
        entry: "holiday",
        holiday_date: "2030-05-13",
        name: "Bad",
        scope: "state",
        state_key,
        source: "Test",
        recorded_by: "rls test",
      });
      expect(bad.error?.code, state_key).toBe("MLDD2");
    }

    // The secret key can't update or delete (no grant), nor can the database owner (MLDD1).
    const upd = await admin.from("official_holidays").update({ name: "Changed" }).eq("id", id);
    expect(upd.error?.code).toBe("42501");
    const del = await admin.from("official_holidays").delete().eq("id", id);
    expect(del.error?.code).toBe("42501");
    for (const sql of [
      "update public.official_holidays set name = 'Changed' where id = $1",
      "delete from public.official_holidays where id = $1",
    ]) {
      await expect(db.query(sql, [id])).rejects.toMatchObject({ code: "MLDD1" });
    }
    await expect(db.query("truncate public.official_holidays cascade")).rejects.toMatchObject({
      code: "MLDD1",
    });
    // Replica mode doesn't skip the guard (ENABLE ALWAYS).
    await db.query("begin");
    try {
      await db.query("set local session_replication_role = replica");
      await expect(
        db.query("update public.official_holidays set name = 'Changed' where id = $1", [id]),
      ).rejects.toMatchObject({ code: "MLDD1" });
    } finally {
      await db.query("rollback");
    }
    const { rows } = await db.query<{ tgname: string; tgenabled: string }>(
      `select tgname, tgenabled from pg_trigger
       where tgrelid = 'public.official_holidays'::regclass and not tgisinternal order by tgname`,
    );
    expect(rows).toEqual([
      { tgname: "official_holidays_guard", tgenabled: "A" },
      { tgname: "official_holidays_no_truncate", tgenabled: "A" },
    ]);

    // Kano PAYE for April 2030 pay: the 10th of May is Kano's holiday, so Thursday 9 May.
    expect(await sqlDeadline("paye", "2030-04-25", "kano")).toBe("2030-05-09");
    expect(await sqlDeadline("paye", "2030-04-25", "lagos")).toBe("2030-05-10");
    expect(await sqlDeadline("nsitf", "2030-04-25", "kano")).toBe("2030-05-15");

    // Withdrawn with a reason, once; then it stops counting.
    const noReason = await admin
      .from("official_holidays")
      .insert({ entry: "withdrawal", withdraws_id: id, recorded_by: "rls test" });
    expect(noReason.error).not.toBeNull();
    const withdrawn = await admin.from("official_holidays").insert({
      entry: "withdrawal",
      withdraws_id: id,
      reason: "Entered for the test",
      recorded_by: "rls test",
    });
    expect(withdrawn.error).toBeNull();
    const again = await admin.from("official_holidays").insert({
      entry: "withdrawal",
      withdraws_id: id,
      reason: "Entered for the test",
      recorded_by: "rls test",
    });
    expect(again.error?.code).toBe("MLDD3");
    expect(await sqlDeadline("paye", "2030-04-25", "kano")).toBe("2030-05-10");
  });
});

describe("the database's due dates agree with statutory.ts", () => {
  const cases: [RemittanceKind, string, string | null][] = [
    ["pension", "2026-10-25", null], // the golden run: Tuesday 3 Nov
    ["pension", "2026-10-01", null], // paid on Independence Day
    ["pension", "2026-12-25", null], // Christmas, Boxing Day and New Year
    ["pension", "2026-09-25", null],
    ["paye", "2026-09-25", "lagos"], // 10 Oct is a Saturday
    ["paye", "2026-11-25", "lagos"],
    ["nhf", "2026-10-31", null], // month end
    ["nhf", "2027-01-31", null], // 28 Feb 2027 is a Sunday
    ["nhf", "2028-01-31", null], // leap year
    ["nsitf", "2026-10-25", null], // 15 Nov is a Sunday
    ["itf", "2026-10-25", null], // 1 Apr 2027
    ["itf", "2027-10-25", null], // 1 Apr 2028 is a Saturday
  ];

  it.each(cases)("%s paid %s (%s)", async (kind, paidOn, state) => {
    const calendar = await standingCalendar();
    const expected = statutoryDeadline(kind, paidOn, deadlineHolidays(calendar, kind, state));
    expect(await sqlDeadline(kind, paidOn, state)).toBe(expected);
  });

  it("applies the company's own day only when earlier", async () => {
    const days = await owner.client.rpc("set_remittance_due_days", {
      p_organisation_id: owner.orgId,
      p_paye: 5,
      p_nsitf: 20,
    });
    expect(days.error).toBeNull();
    const calendar = await standingCalendar();
    const dueDays = { paye: 5, nhf: null, nsitf: 20, itf: null };
    for (const kind of ["paye", "nsitf", "nhf", "itf", "pension"] as const) {
      const authorityKey = kind === "paye" ? "lagos" : null;
      const { rows } = await db.query<{ d: string }>(
        "select private.statutory_due_date($1, $2, '2026-10-25'::date, $3)::text as d",
        [owner.orgId, kind, authorityKey],
      );
      const ts = remittanceDeadline({
        kind,
        authorityKey,
        payDate: "2026-10-25",
        releasedOn: null,
        dueDays,
        calendar,
      });
      expect(rows[0]!.d, kind).toBe(ts.dueDate);
    }
    // PAYE takes the earlier 5th; NSITF ignores the later 20th (Friday 13 Nov stands).
    const { rows } = await db.query<{ paye: string; nsitf: string }>(
      `select private.statutory_due_date($1, 'paye', '2026-10-25', 'lagos')::text as paye,
              private.statutory_due_date($1, 'nsitf', '2026-10-25', null)::text as nsitf`,
      [owner.orgId],
    );
    expect(rows[0]).toEqual({ paye: "2026-11-05", nsitf: "2026-11-13" });
  });

  it("keeps the due-date functions away from signed-in users", async () => {
    const { rows } = await db.query<{ name: string; can: boolean }>(
      `select p.proname as name,
              has_function_privilege('authenticated', p.oid, 'execute') as can
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'private' and p.proname in (
         'official_holiday', 'deadline_working_day', 'deadline_add_working_days',
         'deadline_on_or_before', 'deadline_on_or_after', 'statutory_deadline', 'statutory_due_date'
       )`,
    );
    expect(rows.length).toBe(7);
    expect(rows.filter((r) => r.can)).toEqual([]);
  });
});
