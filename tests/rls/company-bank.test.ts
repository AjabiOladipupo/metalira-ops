/**
 * Slice 2.3 against the real database: the company's collection bank account needs a second
 * approver (owner or finance, never the requester; CLAUDE.md rule 10), waits 72 hours after
 * approval, and only then becomes the account in use. The first account an owner adds while
 * setup is unfinished is the one exception, once. Cross-organisation isolation for the table
 * lives in isolation.test.ts (tables/company_bank.ts).
 */
import { randomBytes, randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/types/db";

import {
  adminClient,
  createTenantUser,
  createTestUser,
  pgClient,
  type Client,
  type TenantUser,
  type TestUser,
} from "./helpers/supabase";

type Role = Database["public"]["Enums"]["membership_role"];

const PERMISSION_DENIED = "42501";
const HOUR = 3_600_000;

let admin: Client;
let db: pg.Client;
let other: TenantUser;

const enc = () => `\\x${randomBytes(48).toString("hex")}`;

interface Company {
  owner: TenantUser;
  people: Record<"admin" | "finance" | "hr" | "ops" | "line" | "worker", TestUser>;
}

async function company(label: string, setupDone: boolean): Promise<Company> {
  const owner = await createTenantUser(`ob-${label}`, `Bank ${label} Ltd`);
  const roles: [keyof Company["people"], Role][] = [
    ["admin", "admin"],
    ["finance", "finance"],
    ["hr", "hr"],
    ["ops", "ops_manager"],
    ["line", "line_manager"],
    ["worker", "worker"],
  ];
  const people = {} as Company["people"];
  for (const [key, role] of roles) {
    const user = await createTestUser(`ob-${label}-${key}`, `${key} person`);
    const { error } = await admin
      .from("memberships")
      .insert({ organisation_id: owner.orgId, user_id: user.id, role });
    expect(error).toBeNull();
    people[key] = user;
  }
  if (setupDone) {
    await db.query("update public.organisations set setup_completed_at = now() where id = $1", [
      owner.orgId,
    ]);
  }
  return { owner, people };
}

function request(c: Company, by: Client, last4 = "4410") {
  return by.rpc("request_org_bank_account", {
    p_organisation_id: c.owner.orgId,
    p_id: randomUUID(),
    p_bank_name: "GTBank",
    p_account_name: "Bank Test Ltd",
    p_bank_account_enc: enc(),
    p_bank_account_last4: last4,
  });
}

async function mustRequest(c: Company, by: Client, last4 = "4410") {
  const { data, error } = await request(c, by, last4);
  expect(error).toBeNull();
  return data![0]!;
}

function decide(c: Company, id: string, decision: string, by: Client) {
  return by.rpc("decide_org_bank_account", {
    p_organisation_id: c.owner.orgId,
    p_id: id,
    p_decision: decision,
  });
}

async function row(id: string) {
  const { rows } = await db.query<{
    status: string;
    requested_by: string;
    approved_by: string | null;
    single_approver: boolean;
    decided_at: Date | null;
    applies_after: Date | null;
    activated_at: Date | null;
    retired_at: Date | null;
  }>(
    `select status, requested_by, approved_by, single_approver, decided_at, applies_after,
       activated_at, retired_at
     from public.organisation_bank_accounts where id = $1`,
    [id],
  );
  return rows[0]!;
}

/** Moves an approved account's hold into the past, as if 72 hours had gone by. */
async function endHold(id: string) {
  await db.query("begin");
  try {
    await db.query(
      "alter table public.organisation_bank_accounts disable trigger organisation_bank_accounts_before_update",
    );
    await db.query(
      `update public.organisation_bank_accounts
       set decided_at = now() - interval '73 hours', applies_after = now() - interval '1 hour'
       where id = $1 and status = 'approved'`,
      [id],
    );
    await db.query(
      "alter table public.organisation_bank_accounts enable trigger organisation_bank_accounts_before_update",
    );
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  other = await createTenantUser("ob-other", "Other Bank Ltd");
});

afterAll(async () => {
  await db.end();
});

describe("the first account during setup (owner decision, 19 Nov 2026)", () => {
  it("lets an owner alone add it, in use at once and audited, once", async () => {
    const c = await company("first", false);
    const first = await mustRequest(c, c.owner.client);
    expect(first).toMatchObject({ status: "active", single_approver: true });
    const stored = await row(first.id);
    expect(stored.approved_by).toBeNull();
    expect(stored.activated_at).not.toBeNull();

    const { rows: audit } = await db.query(
      `select 1 from public.audit_log
       where organisation_id = $1 and action = 'billing.bank_account_single_approver' and entity_id = $2`,
      [c.owner.orgId, first.id],
    );
    expect(audit).toHaveLength(1);

    // The exception is used: the next one waits for a second person, even during setup.
    const second = await mustRequest(c, c.owner.client, "5511");
    expect(second).toMatchObject({ status: "pending", single_approver: false });
  });

  it("can't be used twice by two requests at once", async () => {
    const c = await company("race", false);
    const results = await Promise.all([
      request(c, c.owner.client, "1111"),
      request(c, c.owner.client, "2222"),
    ]);
    const saved = results.flatMap((r) => r.data ?? []);
    expect(saved.filter((r) => r.single_approver)).toHaveLength(1);
    const { rows } = await db.query(
      "select count(*)::int as n from public.organisation_bank_accounts where organisation_id = $1 and status = 'active'",
      [c.owner.orgId],
    );
    expect(rows[0].n).toBe(1);
  });

  it("is not for admin or finance, nor after setup", async () => {
    const during = await company("first-admin", false);
    expect(await mustRequest(during, during.people.admin.client)).toMatchObject({
      status: "pending",
    });
    const finance = await company("first-fin", false);
    expect(await mustRequest(finance, finance.people.finance.client)).toMatchObject({
      status: "pending",
    });
    const after = await company("first-after", true);
    expect(await mustRequest(after, after.owner.client)).toMatchObject({ status: "pending" });
  });
});

describe("two people, then 72 hours", () => {
  let c: Company;
  beforeAll(async () => {
    c = await company("two", true);
  });

  it("refuses the requester approving or rejecting their own request", async () => {
    const mine = await mustRequest(c, c.owner.client);
    for (const decision of ["approve", "reject"]) {
      const { error } = await decide(c, mine.id, decision, c.owner.client);
      expect(error?.code).toBe("MLOB1");
    }
    expect((await row(mine.id)).status).toBe("pending");
    // Withdraw it so the next test can raise one.
    const { error } = await c.owner.client.rpc("withdraw_org_bank_account", {
      p_organisation_id: c.owner.orgId,
      p_id: mine.id,
    });
    expect(error).toBeNull();
    expect((await row(mine.id)).status).toBe("cancelled");
  });

  it("refuses the check constraint even for the table owner", async () => {
    const pending = await mustRequest(c, c.people.admin.client);
    await db.query("begin");
    try {
      await db.query(
        "alter table public.organisation_bank_accounts disable trigger organisation_bank_accounts_before_update",
      );
      await expect(
        db.query(
          `update public.organisation_bank_accounts
           set status = 'approved', approved_by = requested_by, decided_at = now(),
             applies_after = now() + interval '72 hours'
           where id = $1`,
          [pending.id],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await db.query("rollback");
    }
    // Withdrawn by its requester.
    await c.people.admin.client.rpc("withdraw_org_bank_account", {
      p_organisation_id: c.owner.orgId,
      p_id: pending.id,
    });
  });

  it("refuses the secret key approving at all", async () => {
    const pending = await mustRequest(c, c.people.admin.client);
    const { error } = await admin
      .from("organisation_bank_accounts")
      .update({ status: "approved" })
      .eq("id", pending.id);
    expect(error?.code).toBe(PERMISSION_DENIED);
    expect((await row(pending.id)).status).toBe("pending");
    await c.people.admin.client.rpc("withdraw_org_bank_account", {
      p_organisation_id: c.owner.orgId,
      p_id: pending.id,
    });
  });

  it("lets only owner and finance decide", async () => {
    const pending = await mustRequest(c, c.owner.client);
    for (const who of ["admin", "hr", "ops", "line"] as const) {
      const { error } = await decide(c, pending.id, "approve", c.people[who].client);
      expect(error).not.toBeNull();
    }
    expect((await row(pending.id)).status).toBe("pending");

    const { data, error } = await decide(c, pending.id, "approve", c.people.finance.client);
    expect(error).toBeNull();
    const approved = data![0]!;
    expect(approved.status).toBe("approved");
    const stored = await row(pending.id);
    expect(stored.approved_by).toBe(c.people.finance.id);
    expect(stored.applies_after!.getTime() - stored.decided_at!.getTime()).toBe(72 * HOUR);
  });

  it("keeps it on hold, then makes it the account in use and keeps the old one as history", async () => {
    const { rows } = await db.query<{ id: string }>(
      "select id from public.organisation_bank_accounts where organisation_id = $1 and status = 'approved'",
      [c.owner.orgId],
    );
    const id = rows[0]!.id;

    // On hold: nothing to apply, nothing in force, and it can't be forced active.
    expect(
      (
        await c.owner.client.rpc("apply_due_org_bank_accounts", {
          p_organisation_id: c.owner.orgId,
        })
      ).data,
    ).toBe(0);
    const early = await c.owner.client
      .from("organisation_bank_accounts")
      .update({ status: "active" })
      .eq("id", id)
      .select("id");
    expect(early.error?.code).toBe("MLOB3");
    const masked = await c.people.hr.client.rpc("org_bank_account_masked", {
      p_organisation_id: c.owner.orgId,
    });
    expect(masked.data).toEqual([]);

    await endHold(id);
    // In force from the rows themselves, before anything applies it.
    const asOf = await c.people.finance.client.rpc("org_bank_account_as_of", {
      p_organisation_id: c.owner.orgId,
    });
    expect(asOf.data?.[0]?.id).toBe(id);

    expect(
      (
        await c.owner.client.rpc("apply_due_org_bank_accounts", {
          p_organisation_id: c.owner.orgId,
        })
      ).data,
    ).toBe(1);
    expect((await row(id)).status).toBe("active");

    // A replacement retires it: approve a second, end its hold, apply.
    const next = await mustRequest(c, c.people.finance.client, "9090");
    expect((await decide(c, next.id, "approve", c.owner.client)).error).toBeNull();
    await endHold(next.id);
    await admin.rpc("apply_due_org_bank_accounts", {
      p_organisation_id: null as unknown as string,
    });
    expect((await row(next.id)).status).toBe("active");
    const old = await row(id);
    expect(old.status).toBe("retired");
    expect(old.retired_at).not.toBeNull();

    // Every manager sees it masked; nobody but owner, admin and finance reads the table.
    for (const who of ["hr", "ops", "line"] as const) {
      const summary = await c.people[who].client.rpc("org_bank_account_masked", {
        p_organisation_id: c.owner.orgId,
      });
      expect(summary.error).toBeNull();
      expect(summary.data?.[0]).toMatchObject({ id: next.id, bank_account_last4: "9090" });
      expect(Object.keys(summary.data![0]!)).not.toContain("bank_account_enc");
    }
  });

  it("is never deleted", async () => {
    const { rows } = await db.query<{ id: string }>(
      "select id from public.organisation_bank_accounts where organisation_id = $1 limit 1",
      [c.owner.orgId],
    );
    await expect(
      db.query("delete from public.organisation_bank_accounts where id = $1", [rows[0]!.id]),
    ).rejects.toMatchObject({ code: "MLOB4" });
    await expect(db.query("truncate public.organisation_bank_accounts")).rejects.toMatchObject({
      code: "MLOB4",
    });
  });

  it("can only reject a request whose requester has since left", async () => {
    const leaver = await createTestUser("ob-leaver", "Leaving admin");
    expect(
      (
        await admin
          .from("memberships")
          .insert({ organisation_id: c.owner.orgId, user_id: leaver.id, role: "admin" })
      ).error,
    ).toBeNull();
    const pending = await mustRequest(c, leaver.client, "7070");
    await db.query("delete from public.memberships where organisation_id = $1 and user_id = $2", [
      c.owner.orgId,
      leaver.id,
    ]);
    const approved = await decide(c, pending.id, "approve", c.people.finance.client);
    expect(approved.error?.code).toBe("MLOB5");
    const rejected = await decide(c, pending.id, "reject", c.people.finance.client);
    expect(rejected.error).toBeNull();
  });
});

describe("email marks (sweeps over the rows)", () => {
  it("lets the secret key mark each email once, for its own status, and nobody else", async () => {
    const c = await company("marks", true);
    const pending = await mustRequest(c, c.people.admin.client);
    const mark = (patch: Record<string, string>) =>
      admin.from("organisation_bank_accounts").update(patch).eq("id", pending.id).select("id");
    const now = new Date().toISOString();

    // Signed-in users can't write the marks at all (column grants).
    const byOwner = await c.owner.client
      .from("organisation_bank_accounts")
      .update({ requested_notified_at: now })
      .eq("id", pending.id);
    expect(byOwner.error).not.toBeNull();
    // Wrong mark for the status.
    expect((await mark({ approved_notified_at: now })).error?.code).toBe("MLOB4");
    expect((await mark({ requested_notified_at: now })).error).toBeNull();
    // Once only.
    expect((await mark({ requested_notified_at: now })).error?.code).toBe("MLOB4");

    // An approval made straight over the Data API leaves the "approved" email due.
    expect((await decide(c, pending.id, "approve", c.people.finance.client)).error).toBeNull();
    const { rows } = await db.query<{ approved_notified_at: Date | null }>(
      "select approved_notified_at from public.organisation_bank_accounts where id = $1",
      [pending.id],
    );
    expect(rows[0]!.approved_notified_at).toBeNull();
    expect((await mark({ approved_notified_at: now })).error).toBeNull();
  });
});

describe("who can read and request", () => {
  let c: Company;
  beforeAll(async () => {
    c = await company("roles", true);
    await mustRequest(c, c.people.finance.client);
  });

  it("lets only owner, admin and finance run the apply", async () => {
    for (const who of ["hr", "ops", "line", "worker"] as const) {
      const { error } = await c.people[who].client.rpc("apply_due_org_bank_accounts", {
        p_organisation_id: c.owner.orgId,
      });
      expect(error?.code).toBe(PERMISSION_DENIED);
    }
    const { error } = await c.people.admin.client.rpc("apply_due_org_bank_accounts", {
      p_organisation_id: c.owner.orgId,
    });
    expect(error).toBeNull();
  });

  it("hides the table (and its ciphertext) from hr, operations, line managers and workers", async () => {
    for (const who of ["hr", "ops", "line", "worker"] as const) {
      const { data } = await c.people[who].client
        .from("organisation_bank_accounts")
        .select("id, bank_account_enc")
        .eq("organisation_id", c.owner.orgId);
      expect(data ?? []).toEqual([]);
    }
    for (const who of ["admin", "finance"] as const) {
      const { data } = await c.people[who].client
        .from("organisation_bank_accounts")
        .select("id")
        .eq("organisation_id", c.owner.orgId);
      expect(data).toHaveLength(1);
    }
  });

  it("refuses requests from hr, operations, line managers and workers", async () => {
    for (const who of ["hr", "ops", "line", "worker"] as const) {
      const { error } = await request(c, c.people[who].client);
      expect(error?.code).toBe(PERMISSION_DENIED);
    }
  });

  it("refuses the invoice read and the masked read to roles outside them", async () => {
    const asOf = await c.people.hr.client.rpc("org_bank_account_as_of", {
      p_organisation_id: c.owner.orgId,
    });
    expect(asOf.error?.code).toBe(PERMISSION_DENIED);
    const masked = await c.people.worker.client.rpc("org_bank_account_masked", {
      p_organisation_id: c.owner.orgId,
    });
    expect(masked.error?.code).toBe(PERMISSION_DENIED);
  });

  it("refuses another company", async () => {
    const { data: rows } = await admin
      .from("organisation_bank_accounts")
      .select("id")
      .eq("organisation_id", c.owner.orgId);
    const id = rows![0]!.id;
    const read = await other.client.from("organisation_bank_accounts").select("id").eq("id", id);
    expect(read.data).toEqual([]);
    const decided = await other.client.rpc("decide_org_bank_account", {
      p_organisation_id: c.owner.orgId,
      p_id: id,
      p_decision: "approve",
    });
    expect(decided.error).not.toBeNull();
    const asOther = await decide(c, id, "approve", other.client);
    expect(asOther.error).not.toBeNull();
    const masked = await other.client.rpc("org_bank_account_masked", {
      p_organisation_id: c.owner.orgId,
    });
    expect(masked.error?.code).toBe(PERMISSION_DENIED);
    const requested = await request(c, other.client);
    expect(requested.error?.code).toBe(PERMISSION_DENIED);
    const applied = await other.client.rpc("apply_due_org_bank_accounts", {
      p_organisation_id: c.owner.orgId,
    });
    expect(applied.error?.code).toBe(PERMISSION_DENIED);
  });
});
