/**
 * Slice 3.0: business type and module switches on organisations. The switches change only
 * through set_company_modules and the type only through set_company_business_type (owner or
 * admin, trusted session, audited); payroll and shifts need people; no role can update the
 * columns directly; another company's switches are out of reach.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  adminClient,
  anonClient,
  createTenantUser,
  createTestUser,
  insertMembershipAsOwner,
  pgClient,
  type Client,
  type TenantUser,
  type TestUser,
} from "./helpers/supabase";

const PERMISSION_DENIED = "42501";
const CHECK_VIOLATION = "23514";
const ALL_ON = { shifts_enabled: true, people_enabled: true, payroll_enabled: true };
const ALL_OFF = { shifts_enabled: false, people_enabled: false, payroll_enabled: false };

let admin: Client;
let a: TenantUser;
let b: TenantUser;
let adminA: TestUser;
const managers: Record<string, TestUser> = {};

async function switches(orgId: string) {
  const { data, error } = await admin
    .from("organisations")
    .select("business_type, shifts_enabled, people_enabled, payroll_enabled")
    .eq("id", orgId)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function reset(orgId: string) {
  const db = await pgClient();
  try {
    await db.query(
      "update public.organisations set business_type = 'workforce', shifts_enabled = true, people_enabled = true, payroll_enabled = true, setup_completed_at = null where id = $1",
      [orgId],
    );
  } finally {
    await db.end();
  }
}

function setModules(
  client: Client,
  orgId: string,
  m: { shifts: boolean; people: boolean; payroll: boolean },
) {
  return client.rpc("set_company_modules", {
    p_organisation_id: orgId,
    p_shifts_enabled: m.shifts,
    p_people_enabled: m.people,
    p_payroll_enabled: m.payroll,
  });
}

beforeAll(async () => {
  admin = adminClient();
  a = await createTenantUser("mod-a", "Modules A");
  b = await createTenantUser("mod-b", "Modules B");
  adminA = await createTestUser("mod-admin");
  const rows = [{ organisation_id: a.orgId, user_id: adminA.id, role: "admin" as const }];
  for (const role of ["hr", "finance", "ops_manager", "line_manager", "worker"] as const) {
    managers[role] = await createTestUser(`mod-${role}`);
    rows.push({ organisation_id: a.orgId, user_id: managers[role]!.id, role } as never);
  }
  const { error } = await admin.from("memberships").insert(rows);
  if (error) throw new Error(error.message);
});

afterAll(async () => {
  await reset(a.orgId);
  await reset(b.orgId);
});

describe("defaults", () => {
  it("starts a new company as workforce with every module on", async () => {
    expect(await switches(a.orgId)).toEqual({ business_type: "workforce", ...ALL_ON });
  });

  it("accepts the two new industries", async () => {
    for (const industry of ["digital_services", "professional_services"]) {
      const { error } = await a.client.from("organisations").update({ industry }).eq("id", a.orgId);
      expect(error, industry).toBeNull();
    }
    const { error } = await a.client
      .from("organisations")
      .update({ industry: "mining" })
      .eq("id", a.orgId);
    expect(error?.code).toBe(CHECK_VIOLATION);
  });
});

describe("set_company_modules", () => {
  it("lets the owner and an admin switch modules, and audits each change", async () => {
    await reset(a.orgId);
    const off = await setModules(a.client, a.orgId, { shifts: false, people: true, payroll: true });
    expect(off.error).toBeNull();
    expect(off.data).toMatchObject({ changed: true, shifts_enabled: false });
    expect(await switches(a.orgId)).toMatchObject({ shifts_enabled: false, people_enabled: true });

    const on = await setModules(adminA.client, a.orgId, {
      shifts: true,
      people: true,
      payroll: true,
    });
    expect(on.error).toBeNull();
    expect(await switches(a.orgId)).toMatchObject(ALL_ON);

    const { data: audit } = await admin
      .from("audit_log")
      .select("actor_id, before, after")
      .eq("organisation_id", a.orgId)
      .eq("action", "company.modules_changed")
      .order("at", { ascending: true });
    expect(audit?.map((r) => r.actor_id)).toEqual([a.id, adminA.id]);
    expect(audit?.[0]?.before).toMatchObject({ shifts_enabled: true });
    expect(audit?.[0]?.after).toMatchObject({ shifts_enabled: false });
  });

  it("writes nothing when nothing changes", async () => {
    await reset(a.orgId);
    const { count: before } = await admin
      .from("audit_log")
      .select("id", { count: "exact", head: true })
      .eq("organisation_id", a.orgId)
      .eq("action", "company.modules_changed");
    const same = await setModules(a.client, a.orgId, { shifts: true, people: true, payroll: true });
    expect(same.error).toBeNull();
    expect(same.data).toMatchObject({ changed: false });
    const { count: after } = await admin
      .from("audit_log")
      .select("id", { count: "exact", head: true })
      .eq("organisation_id", a.orgId)
      .eq("action", "company.modules_changed");
    expect(after).toBe(before);
  });

  it.each(["hr", "finance", "ops_manager", "line_manager", "worker"])(
    "refuses %s",
    async (role) => {
      await reset(a.orgId);
      const { error } = await setModules(managers[role]!.client, a.orgId, {
        shifts: false,
        people: false,
        payroll: false,
      });
      expect(error?.code).toBe(PERMISSION_DENIED);
      expect(await switches(a.orgId)).toMatchObject(ALL_ON);
    },
  );

  it("refuses the anon role and another company's owner", async () => {
    await reset(a.orgId);
    const anon = await setModules(anonClient(), a.orgId, {
      shifts: false,
      people: false,
      payroll: false,
    });
    expect(anon.error).not.toBeNull();
    const cross = await setModules(b.client, a.orgId, {
      shifts: false,
      people: false,
      payroll: false,
    });
    expect(cross.error?.code).toBe(PERMISSION_DENIED);
    expect(await switches(a.orgId)).toMatchObject(ALL_ON);
  });

  it("refuses an owner whose password session is not trusted", async () => {
    await reset(a.orgId);
    const email = `rls-mod-untrusted-${crypto.randomUUID()}@example.test`;
    const password = `${crypto.randomUUID()}a1`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    await insertMembershipAsOwner(a.orgId, created.data.user!.id, "owner");
    const client = anonClient();
    expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
    const { error } = await setModules(client, a.orgId, {
      shifts: false,
      people: false,
      payroll: false,
    });
    expect(error?.code).toBe(PERMISSION_DENIED);
    expect(await switches(a.orgId)).toMatchObject(ALL_ON);
  });

  it("refuses payroll without people (MLMO1) and shifts without people (MLMO2)", async () => {
    await reset(a.orgId);
    const payroll = await setModules(a.client, a.orgId, {
      shifts: false,
      people: false,
      payroll: true,
    });
    expect(payroll.error?.code).toBe("MLMO1");
    expect(payroll.error?.message).toBe(
      "Payroll needs People. Turn People on, or turn Payroll off.",
    );
    const shifts = await setModules(a.client, a.orgId, {
      shifts: true,
      people: false,
      payroll: false,
    });
    expect(shifts.error?.code).toBe("MLMO2");
    expect(await switches(a.orgId)).toMatchObject(ALL_ON);
  });

  it("is backed by check constraints even for the database owner", async () => {
    const db = await pgClient();
    try {
      for (const set of [
        "people_enabled = false, payroll_enabled = true, shifts_enabled = false",
        "people_enabled = false, payroll_enabled = false, shifts_enabled = true",
      ]) {
        await expect(
          db.query(`update public.organisations set ${set} where id = $1`, [a.orgId]),
        ).rejects.toMatchObject({ code: CHECK_VIOLATION });
      }
    } finally {
      await db.end();
    }
  });
});

describe("direct updates", () => {
  it.each(["business_type", "shifts_enabled", "people_enabled", "payroll_enabled"] as const)(
    "no one can update %s through the Data API, the owner included",
    async (column) => {
      await reset(a.orgId);
      const patch =
        column === "business_type" ? { business_type: "services" } : { [column]: false };
      for (const client of [a.client, adminA.client, managers.ops_manager!.client, b.client]) {
        const { data, error } = await client
          .from("organisations")
          .update(patch)
          .eq("id", a.orgId)
          .select("id");
        // The owner and admin hit the missing column grant; others also match no row under RLS.
        expect(error?.code === PERMISSION_DENIED || (data ?? []).length === 0).toBe(true);
      }
      expect(await switches(a.orgId)).toEqual({ business_type: "workforce", ...ALL_ON });
    },
  );

  it("a manager can't update the organisation row at all", async () => {
    const { data, error } = await managers
      .ops_manager!.client.from("organisations")
      .update({ industry: "cleaning" })
      .eq("id", a.orgId)
      .select("id");
    expect(error?.code === PERMISSION_DENIED || (data ?? []).length === 0).toBe(true);
  });
});

describe("set_company_business_type", () => {
  it("during setup, services turns every module off and workforce turns them back on", async () => {
    await reset(a.orgId);
    const services = await a.client.rpc("set_company_business_type", {
      p_organisation_id: a.orgId,
      p_business_type: "services",
    });
    expect(services.error).toBeNull();
    expect(services.data).toMatchObject({ changed: true, modules_reset: true });
    expect(await switches(a.orgId)).toEqual({ business_type: "services", ...ALL_OFF });

    // Same type again: nothing changes.
    const again = await a.client.rpc("set_company_business_type", {
      p_organisation_id: a.orgId,
      p_business_type: "services",
    });
    expect(again.data).toMatchObject({ changed: false });

    await a.client.rpc("set_company_business_type", {
      p_organisation_id: a.orgId,
      p_business_type: "workforce",
    });
    expect(await switches(a.orgId)).toEqual({ business_type: "workforce", ...ALL_ON });

    const { data: audit } = await admin
      .from("audit_log")
      .select("actor_id, after")
      .eq("organisation_id", a.orgId)
      .eq("action", "company.business_type_set");
    expect(audit?.length).toBeGreaterThanOrEqual(2);
    expect(audit?.every((r) => r.actor_id === a.id)).toBe(true);
  });

  it("after setup, changes only the type and leaves the switches alone", async () => {
    await reset(a.orgId);
    const done = await a.client.rpc("complete_company_setup", { p_organisation_id: a.orgId });
    expect(done.error).toBeNull();
    const { data, error } = await a.client.rpc("set_company_business_type", {
      p_organisation_id: a.orgId,
      p_business_type: "services",
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ changed: true, modules_reset: false });
    expect(await switches(a.orgId)).toEqual({ business_type: "services", ...ALL_ON });
  });

  it("refuses managers, another company and unknown types", async () => {
    await reset(a.orgId);
    for (const client of [managers.hr!.client, managers.ops_manager!.client, b.client]) {
      const { error } = await client.rpc("set_company_business_type", {
        p_organisation_id: a.orgId,
        p_business_type: "services",
      });
      expect(error?.code).toBe(PERMISSION_DENIED);
    }
    const { error } = await a.client.rpc("set_company_business_type", {
      p_organisation_id: a.orgId,
      p_business_type: "farming",
    });
    expect(error?.code).toBe("22023");
    expect(await switches(a.orgId)).toEqual({ business_type: "workforce", ...ALL_ON });
  });
});

describe("function grants", () => {
  it("are not executable by anon, and the private hook is not callable by signed-in users", async () => {
    const db = await pgClient();
    try {
      const { rows } = await db.query<{ fn: string; anon: boolean; authenticated: boolean }>(
        `select p.oid::regprocedure::text as fn,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as authenticated
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname in ('public', 'private')
           and p.proname in ('set_company_modules', 'set_company_business_type',
                             'assert_shifts_can_be_switched_off')`,
      );
      expect(rows).toHaveLength(5);
      for (const row of rows) expect(row.anon, row.fn).toBe(false);
      const hook = rows.find((r) => r.fn.includes("assert_shifts_can_be_switched_off"));
      expect(hook?.authenticated).toBe(false);
    } finally {
      await db.end();
    }
  });
});
