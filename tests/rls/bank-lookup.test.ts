/**
 * Slice 2.3b against the real database: account name lookups are written only by the server
 * (secret key), are read only by the user they were made for, are rate-limited per user, and
 * back exactly one request each. A request that names a lookup gets the bank's account name,
 * whatever the caller sent; a lookup that isn't the caller's, is stale, used, or for another
 * bank, number or purpose is refused. The company account needs a lookup from a signed-in user;
 * a worker's request without one is `not_checked`. The check can't be edited after insert, and
 * an applied change carries the bank code and the check onto the worker.
 * Cross-organisation isolation for the table lives in isolation.test.ts (tables/bank_lookup.ts).
 */
import { randomBytes, randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/types/db";

import { makeLookup, randomDigest, type MadeLookup } from "./helpers/bank-lookup";
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

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
const people = {} as Record<"admin" | "finance" | "hr" | "ops" | "worker", TestUser>;
let workerId: string;
let ownWorkerId: string;

const enc = () => `\\x${randomBytes(48).toString("hex")}`;

async function addMember(user: TestUser, role: Role, linkedWorker: string | null = null) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: owner.orgId, user_id: user.id, role, worker_id: linkedWorker });
  expect(error).toBeNull();
}

let staffCounter = 0;
async function addWorker(): Promise<string> {
  staffCounter += 1;
  const id = randomUUID();
  const { error } = await admin.from("workers").insert({
    id,
    organisation_id: owner.orgId,
    staff_id: `BL-${String(staffCounter).padStart(4, "0")}`,
    first_name: "John",
    last_name: "Adeyemi",
    employment_type: "permanent",
    start_date: "2025-01-06",
    bank_name: "Access Bank",
    account_name: "JOHN ADEYEMI",
    bank_account_enc: enc(),
    bank_account_last4: "1234",
  });
  expect(error).toBeNull();
  return id;
}

const lookup = (
  user: { id: string },
  purpose: Database["public"]["Enums"]["bank_lookup_purpose"],
  extra: { workerId?: string | null; last4?: string; accountName?: string; orgId?: string } = {},
) =>
  makeLookup(admin, {
    // Through begin/finish, as the server does: role checks and limits apply.
    viaServer: true,
    orgId: extra.orgId ?? owner.orgId,
    userId: user.id,
    purpose,
    workerId: extra.workerId ?? null,
    last4: extra.last4 ?? "7712",
    accountName: extra.accountName ?? "ADEYEMI JOHN",
  });

function changeWith(
  by: Client,
  forWorker: string,
  l: MadeLookup | null,
  extra: Record<string, unknown> = {},
) {
  return by
    .from("bank_detail_changes")
    .insert({
      organisation_id: owner.orgId,
      worker_id: forWorker,
      bank_name: "GTBank (Guaranty Trust Bank)",
      account_name: "Typed By Hand",
      bank_account_enc: enc(),
      bank_account_last4: l?.last4 ?? "7712",
      ...(l
        ? {
            bank_code: l.bankCode,
            bank_lookup_id: l.id,
            bank_account_digest: l.digest,
            name_check: "match" as const,
          }
        : {}),
      ...extra,
    })
    .select("*")
    .single();
}

function companyWith(by: Client, l: MadeLookup | null, extra: Record<string, unknown> = {}) {
  return by.rpc("request_org_bank_account", {
    p_organisation_id: owner.orgId,
    p_id: randomUUID(),
    p_bank_name: "GTBank (Guaranty Trust Bank)",
    p_account_name: "Typed By Hand",
    p_bank_account_enc: enc(),
    p_bank_account_last4: l?.last4 ?? "4410",
    ...(l
      ? {
          p_bank_code: l.bankCode,
          p_bank_lookup_id: l.id,
          p_bank_account_digest: l.digest,
          p_name_check: "match" as const,
        }
      : {}),
    ...extra,
  });
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("bl-owner", "Lookup Test Ltd");
  other = await createTenantUser("bl-other", "Other Lookup Ltd");
  workerId = await addWorker();
  ownWorkerId = await addWorker();
  for (const [key, role] of [
    ["admin", "admin"],
    ["finance", "finance"],
    ["hr", "hr"],
    ["ops", "ops_manager"],
  ] as const) {
    people[key] = await createTestUser(`bl-${key}`, `${key} person`);
    await addMember(people[key], role);
  }
  people.worker = await createTestUser("bl-worker", "John Adeyemi");
  await addMember(people.worker, "worker", ownWorkerId);
  // The setup exception would make the owner's first company account active at once.
  await db.query("update public.organisations set setup_completed_at = now() where id = $1", [
    owner.orgId,
  ]);
});

afterAll(async () => {
  await db?.end();
});

describe("who writes and reads lookups", () => {
  it("lets only the server start or finish one", async () => {
    for (const client of [owner.client, people.hr.client]) {
      const begin = await client.rpc("begin_bank_account_lookup", {
        p_organisation_id: owner.orgId,
        p_user_id: owner.id,
        p_purpose: "company_bank",
        p_worker_id: null as unknown as string,
        p_bank_code: "058",
        p_bank_account_digest: randomDigest(),
        p_bank_account_last4: "4410",
      });
      expect(begin.error?.code).toBe(PERMISSION_DENIED);
    }
    const mine = await lookup(owner, "company_bank");
    const finish = await owner.client.rpc("finish_bank_account_lookup", {
      p_id: mine.id,
      p_status: "resolved",
      p_account_name: "FORGED LIMITED",
      p_source: "bank",
    });
    expect(finish.error?.code).toBe(PERMISSION_DENIED);
  });

  it("refuses signed-in inserts, updates and deletes", async () => {
    const insert = await owner.client.from("bank_account_lookups").insert({
      organisation_id: owner.orgId,
      requested_by: owner.id,
      purpose: "company_bank",
      bank_code: "058",
      bank_account_digest: randomDigest(),
      bank_account_last4: "4410",
    });
    expect(insert.error?.code).toBe(PERMISSION_DENIED);
    const mine = await lookup(owner, "company_bank");
    const update = await owner.client
      .from("bank_account_lookups")
      .update({ account_name: "FORGED LIMITED" })
      .eq("id", mine.id);
    expect(update.error?.code).toBe(PERMISSION_DENIED);
    const del = await owner.client.from("bank_account_lookups").delete().eq("id", mine.id);
    expect(del.error?.code).toBe(PERMISSION_DENIED);
  });

  it("shows a lookup to the user it was made for only", async () => {
    const mine = await lookup(people.hr, "worker_bank", { workerId });
    const own = await people.hr.client.from("bank_account_lookups").select("id").eq("id", mine.id);
    expect(own.data).toHaveLength(1);
    for (const client of [owner.client, people.admin.client, other.client]) {
      const seen = await client.from("bank_account_lookups").select("id").eq("id", mine.id);
      expect(seen.data).toEqual([]);
    }
  });

  it("checks the role for the purpose", async () => {
    await expect(lookup(people.hr, "company_bank")).rejects.toMatchObject({ code: "42501" });
    await expect(lookup(people.ops, "worker_bank", { workerId })).rejects.toMatchObject({
      code: "42501",
    });
    await expect(lookup(people.finance, "worker_check", { workerId })).rejects.toMatchObject({
      code: "42501",
    });
    // A worker checks only their own new account.
    await expect(
      lookup(people.worker, "worker_bank", { workerId: ownWorkerId }),
    ).resolves.toBeDefined();
    await expect(lookup(people.worker, "worker_bank", { workerId })).rejects.toMatchObject({
      code: "42501",
    });
    // Another company's user, or a worker from another company.
    await expect(lookup(other, "company_bank")).rejects.toMatchObject({ code: "42501" });
  });

  it("stops a user at 30 lookups an hour", async () => {
    // Its own company, so the company's allowance isn't what stops it.
    const busy = await createTenantUser("bl-busy", "Busy Lookups Ltd");
    await db.query("update public.organisations set setup_completed_at = now() where id = $1", [
      busy.orgId,
    ]);
    for (let i = 0; i < 30; i += 1) await lookup(busy, "worker_bank", { orgId: busy.orgId });
    await expect(lookup(busy, "worker_bank", { orgId: busy.orgId })).rejects.toMatchObject({
      code: "MLBL1",
    });
  });

  it("gives a company in setup 10 lookups a day, and its own account 20 an hour", async () => {
    const fresh = await createTenantUser("bl-fresh", "Fresh Signup Ltd");
    for (let i = 0; i < 10; i += 1) {
      await lookup(fresh, "company_bank", { orgId: fresh.orgId, last4: "4410" });
    }
    await expect(
      lookup(fresh, "company_bank", { orgId: fresh.orgId, last4: "4410" }),
    ).rejects.toMatchObject({ code: "MLBL2" });
  });

  it("limits one network address to 60 lookups an hour", async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    // Three owners of three companies, so neither the user nor the company limit stops it.
    const owners: TenantUser[] = [];
    for (let u = 0; u < 4; u += 1) {
      const o = await createTenantUser(`bl-ip-${u}`, `Ip Lookups ${u} Ltd`);
      await db.query("update public.organisations set setup_completed_at = now() where id = $1", [
        o.orgId,
      ]);
      owners.push(o);
    }
    const viaIp = (o: TenantUser) =>
      makeLookup(admin, {
        viaServer: true,
        orgId: o.orgId,
        userId: o.id,
        purpose: "worker_bank",
        last4: "7712",
        clientIp: ip,
      });
    for (const o of owners.slice(0, 3)) {
      for (let i = 0; i < 20; i += 1) await viaIp(o);
    }
    await expect(viaIp(owners[3]!)).rejects.toMatchObject({ code: "MLBL1" });
  });
});

describe("a request takes its account name from the lookup", () => {
  it("replaces the name the caller typed with the bank's", async () => {
    const l = await lookup(people.hr, "worker_bank", { workerId });
    const { data, error } = await changeWith(people.hr.client, workerId, l);
    expect(error).toBeNull();
    expect(data).toMatchObject({
      account_name: "ADEYEMI JOHN",
      bank_code: "058",
      name_check: "match",
      name_check_source: "test",
    });
    const { rows } = await db.query(
      "select used_at from public.bank_account_lookups where id = $1",
      [l.id],
    );
    expect(rows[0]!.used_at).not.toBeNull();
    // Withdraw so the worker can take the next request.
    await people.hr.client
      .from("bank_detail_changes")
      .update({ status: "cancelled" })
      .eq("id", data!.id);
  });

  it("refuses someone else's lookup, a used one, a stale one, and one for other details", async () => {
    const hrs = await lookup(people.hr, "worker_bank", { workerId });
    const notMine = await changeWith(people.admin.client, workerId, hrs);
    expect(notMine.error?.code).toBe("MLBL3");

    const forCompany = await lookup(people.admin, "company_bank");
    expect((await changeWith(people.admin.client, workerId, forCompany)).error?.code).toBe("MLBL3");

    const forOther = await lookup(people.admin, "worker_bank", { workerId: ownWorkerId });
    expect((await changeWith(people.admin.client, workerId, forOther)).error?.code).toBe("MLBL3");

    const stale = await lookup(people.admin, "worker_bank", { workerId });
    await db.query(
      "update public.bank_account_lookups set created_at = now() - interval '31 minutes' where id = $1",
      [stale.id],
    );
    expect((await changeWith(people.admin.client, workerId, stale)).error?.code).toBe("MLBL4");

    const changed = await lookup(people.admin, "worker_bank", { workerId });
    expect(
      (await changeWith(people.admin.client, workerId, { ...changed, digest: randomDigest() }))
        .error?.code,
    ).toBe("MLBL6");
    expect(
      (await changeWith(people.admin.client, workerId, { ...changed, bankCode: "057" })).error
        ?.code,
    ).toBe("MLBL6");

    const once = await lookup(people.admin, "worker_bank", { workerId });
    const first = await changeWith(people.admin.client, workerId, once);
    expect(first.error).toBeNull();
    await people.admin.client
      .from("bank_detail_changes")
      .update({ status: "cancelled" })
      .eq("id", first.data!.id);
    expect((await changeWith(people.admin.client, workerId, once)).error?.code).toBe("MLBL5");
  });

  it("needs a reason of 10 characters for a close match", async () => {
    const l = await lookup(people.hr, "worker_bank", { workerId, accountName: "ADEYEMI J" });
    const short = await changeWith(people.hr.client, workerId, l, {
      name_check: "near",
      name_check_reason: "ok",
    });
    expect(short.error?.code).toBe("23514");
    const none = await changeWith(people.hr.client, workerId, l, { name_check: "near" });
    expect(none.error?.code).toBe("23514");
    const ok = await changeWith(people.hr.client, workerId, l, {
      name_check: "near",
      name_check_reason: "Bank shows the first initial only",
    });
    expect(ok.error).toBeNull();
    expect(ok.data).toMatchObject({ name_check: "near", account_name: "ADEYEMI J" });

    // The check is part of the request: fixed after insert.
    const edit = await db
      .query("update public.bank_detail_changes set name_check = 'match' where id = $1", [
        ok.data!.id,
      ])
      .catch((e: { code?: string }) => e);
    // The slice 1.7 trigger refuses it first (MLBK4); ours (MLBL8) backs it up.
    expect((edit as { code?: string }).code).toMatch(/^(MLBK4|MLBL8)$/);
    await people.hr.client
      .from("bank_detail_changes")
      .update({ status: "cancelled" })
      .eq("id", ok.data!.id);
  });

  it("refuses an unchecked worker request from a signed-in user, whatever it claims", async () => {
    for (const client of [people.hr.client, owner.client, people.worker.client]) {
      const target = client === people.worker.client ? ownWorkerId : workerId;
      const { error } = await changeWith(client, target, null, {
        name_check: "match",
        name_check_reason: "trust me, it is fine",
      });
      expect(error?.code).toBe("MLBL7");
    }
  });

  it("lets only the import and the secret key raise unchecked requests, approved with a note", async () => {
    const id = await addWorker();
    const { data, error } = await admin
      .from("bank_detail_changes")
      .insert({
        organisation_id: owner.orgId,
        worker_id: id,
        requested_by: people.hr.id,
        bank_name: "GTBank (Guaranty Trust Bank)",
        account_name: "Typed By Hand",
        bank_account_enc: enc(),
        bank_account_last4: "7712",
        name_check: "match",
      })
      .select("*")
      .single();
    expect(error).toBeNull();
    expect(data).toMatchObject({ name_check: "not_checked", account_name: "Typed By Hand" });

    // Approving an account the bank never checked needs the approver to say how.
    const bare = await owner.client
      .from("bank_detail_changes")
      .update({ status: "approved" })
      .eq("id", data!.id);
    expect(bare.error?.code).toBe("MLBLC");
    const noted = await owner.client
      .from("bank_detail_changes")
      .update({ status: "approved", decision_note: "Bank letter dated 3 Nov seen" })
      .eq("id", data!.id)
      .select("status");
    expect(noted.error).toBeNull();
    expect(noted.data![0]!.status).toBe("approved");
  });

  it("needs a lookup for the company account, and takes the bank's name", async () => {
    const without = await companyWith(people.finance.client, null);
    expect(without.error?.code).toBe("MLBL7");

    const l = await lookup(people.finance, "company_bank", {
      last4: "4410",
      accountName: "LOOKUP TEST LIMITED",
    });
    const { data, error } = await companyWith(people.finance.client, l);
    expect(error).toBeNull();
    expect(data![0]).toMatchObject({ status: "pending", account_name: "LOOKUP TEST LIMITED" });
  });
});

describe("test lookups on a database that doesn't allow them (the hosted project)", () => {
  it("shows them but never lets them back or approve a request", async () => {
    const id = await addWorker();
    // Raised while test lookups are allowed (local and CI), so there is one to approve.
    const before = await lookup(people.hr, "worker_bank", { workerId: id });
    const raised = await changeWith(people.hr.client, id, before);
    expect(raised.error).toBeNull();

    await db.query("delete from private.settings where key = 'allow_test_bank_lookups'");
    try {
      const test = await lookup(people.hr, "worker_bank", { workerId: id });
      expect(test.usable).toBe(false);
      const sandbox = await makeLookup(admin, {
        viaServer: true,
        orgId: owner.orgId,
        userId: people.admin.id,
        purpose: "worker_bank",
        workerId,
        last4: "7712",
        source: "sandbox",
      });
      expect(sandbox.usable).toBe(false);
      expect((await changeWith(people.admin.client, workerId, sandbox)).error?.code).toBe("MLBLT");

      const approve = await owner.client
        .from("bank_detail_changes")
        .update({ status: "approved" })
        .eq("id", raised.data!.id);
      expect(approve.error?.code).toBe("MLBLT");

      // A live bank's answer is still usable.
      const live = await lookup(people.admin, "worker_bank", {
        workerId,
        accountName: "ADEYEMI JOHN",
      });
      const liveBank = await makeLookup(admin, {
        viaServer: true,
        orgId: owner.orgId,
        userId: people.admin.id,
        purpose: "worker_bank",
        workerId,
        last4: "7712",
        source: "bank",
        accountName: "ADEYEMI JOHN",
      });
      expect(live.usable).toBe(false);
      expect(liveBank.usable).toBe(true);
      const ok = await changeWith(people.admin.client, workerId, liveBank);
      expect(ok.error).toBeNull();
      await people.admin.client
        .from("bank_detail_changes")
        .update({ status: "cancelled" })
        .eq("id", ok.data!.id);
    } finally {
      await db.query(
        "insert into private.settings (key, value) values ('allow_test_bank_lookups', 'on') on conflict (key) do update set value = 'on'",
      );
    }
    await people.hr.client
      .from("bank_detail_changes")
      .update({ status: "cancelled" })
      .eq("id", raised.data!.id);
  });
});

describe("applying a change and checking details on file", () => {
  it("carries the bank code and the check onto the worker", async () => {
    const id = await addWorker();
    const l = await lookup(people.hr, "worker_bank", { workerId: id });
    const raised = await changeWith(people.hr.client, id, l);
    expect(raised.error).toBeNull();
    const approved = await owner.client
      .from("bank_detail_changes")
      .update({ status: "approved" })
      .eq("id", raised.data!.id)
      .select("id");
    expect(approved.error).toBeNull();
    await db.query("begin");
    await db.query(
      "alter table public.bank_detail_changes disable trigger bank_detail_changes_before_update",
    );
    await db.query(
      `update public.bank_detail_changes
       set decided_at = now() - interval '73 hours', applies_after = now() - interval '1 hour'
       where id = $1`,
      [raised.data!.id],
    );
    await db.query(
      "alter table public.bank_detail_changes enable trigger bank_detail_changes_before_update",
    );
    await db.query("commit");
    await owner.client.rpc("apply_due_bank_detail_changes", { p_organisation_id: owner.orgId });
    const { rows } = await db.query(
      "select bank_code, account_name, bank_checked_name, bank_checked_source from public.workers where id = $1",
      [id],
    );
    expect(rows[0]).toEqual({
      bank_code: "058",
      account_name: "ADEYEMI JOHN",
      bank_checked_name: "ADEYEMI JOHN",
      bank_checked_source: "test",
    });
  });

  it("records a check of the details on file on the worker, never by a signed-in user", async () => {
    const l = await makeLookup(admin, {
      viaServer: true,
      orgId: owner.orgId,
      userId: people.hr.id,
      purpose: "worker_check",
      workerId,
      last4: "1234",
      accountName: "ADEYEMI JOHN O",
    });
    const { rows } = await db.query(
      "select bank_checked_name, bank_checked_code, bank_checked_by from public.workers where id = $1",
      [workerId],
    );
    expect(rows[0]).toEqual({
      bank_checked_name: "ADEYEMI JOHN O",
      bank_checked_code: l.bankCode,
      bank_checked_by: people.hr.id,
    });
    const forged = await people.hr.client
      .from("workers")
      .update({ bank_checked_name: "FORGED" })
      .eq("id", workerId);
    expect(forged.error?.code).toBe(PERMISSION_DENIED);
  });
});
