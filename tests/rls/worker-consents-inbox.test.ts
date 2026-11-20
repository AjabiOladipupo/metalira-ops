/**
 * Slice 3.1 against the real database:
 * - worker_consents: the worker agrees and withdraws through the RPCs only, reads their own rows,
 *   never edits or deletes one; owner, admin and HR read all; other companies get nothing;
 *   private.worker_has_consent follows the open row.
 * - inbox_items: the worker reads only their own items and can only set read_at (to now, once);
 *   owner, admin and HR read them, other managers don't; only the server adds items; the email
 *   caps in claim_inbox_email.
 * - organisations attendance settings: ranges, roles and the audit row.
 * Cross-organisation isolation of both tables lives in isolation.test.ts
 * (tables/worker-consents-inbox.ts).
 */
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/types/db";

import {
  adminClient,
  anonClient,
  createTenantUser,
  createTestUser,
  pgClient,
  type Client,
  type TenantUser,
  type TestUser,
} from "./helpers/supabase";

type Role = Database["public"]["Enums"]["membership_role"];

const PERMISSION_DENIED = "42501";
const PIN_HASH = `s1$k1$${"A".repeat(22)}$${"B".repeat(43)}`;
const VERSION = "2026-11-20.1";

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
const staff = {} as Record<"admin" | "hr" | "finance" | "ops" | "lineManager", TestUser>;
let counter = 0;

async function addMember(user: TestUser, role: Role, orgId = owner.orgId) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

async function addWorker(orgId = owner.orgId, email: string | null = null): Promise<string> {
  counter += 1;
  const { data, error } = await admin
    .from("workers")
    .insert({
      organisation_id: orgId,
      staff_id: `CI-${String(counter).padStart(4, "0")}`,
      first_name: "Musa",
      last_name: `Ibrahim ${counter}`,
      employment_type: "permanent",
      start_date: "2025-01-06",
      email,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

/** An invited worker who has set a PIN, with a session opened the way the server does it. */
async function workerSession(workerId: string, orgId = owner.orgId, inviter?: TestUser) {
  const invite = await (inviter ?? staff.hr).client.rpc("create_worker_invites", {
    p_organisation_id: orgId,
    p_worker_ids: [workerId],
    p_sent_via: "print",
  });
  expect(invite.error).toBeNull();
  const email = `w-${workerId}@workers.metalira.invalid`;
  const login = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    app_metadata: { login: "worker" },
  });
  expect(login.error).toBeNull();
  const accepted = await admin.rpc("accept_worker_invite", {
    p_token: invite.data![0]!.token,
    p_auth_user_id: login.data.user!.id,
    p_pin_hash: PIN_HASH,
  });
  expect(accepted.error).toBeNull();
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  expect(link.error).toBeNull();
  const client = anonClient();
  const verified = await client.auth.verifyOtp({
    type: "email",
    token_hash: link.data.properties!.hashed_token,
  });
  expect(verified.error).toBeNull();
  return client;
}

async function hasConsent(worker: string, kind: string): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    "select private.worker_has_consent($1, $2, $3) as ok",
    [owner.orgId, worker, kind],
  );
  return rows[0]!.ok;
}

let me: string;
let colleague: string;
let otherWorker: string;
let meClient: Client;
let colleagueClient: Client;
let otherClient: Client;

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("ci-owner", "Consent Inbox Org");
  other = await createTenantUser("ci-other", "Other Consent Org");
  staff.admin = await createTestUser("ci-admin");
  staff.hr = await createTestUser("ci-hr");
  staff.finance = await createTestUser("ci-finance");
  staff.ops = await createTestUser("ci-ops");
  staff.lineManager = await createTestUser("ci-line-manager");
  await addMember(staff.admin, "admin");
  await addMember(staff.hr, "hr");
  await addMember(staff.finance, "finance");
  await addMember(staff.ops, "ops_manager");
  await addMember(staff.lineManager, "line_manager");
  me = await addWorker();
  colleague = await addWorker();
  otherWorker = await addWorker(other.orgId);
  meClient = await workerSession(me);
  colleagueClient = await workerSession(colleague);
  otherClient = await workerSession(otherWorker, other.orgId, other);
});

afterAll(async () => {
  await db?.end();
});

describe("worker_consents", () => {
  it("the worker agrees through the RPC; agreeing again keeps the same consent", async () => {
    expect(await hasConsent(me, "location")).toBe(false);
    const first = await meClient.rpc("accept_worker_consent", {
      p_organisation_id: owner.orgId,
      p_kind: "location",
      p_notice_version: VERSION,
    });
    expect(first.error).toBeNull();
    const again = await meClient.rpc("accept_worker_consent", {
      p_organisation_id: owner.orgId,
      p_kind: "location",
      p_notice_version: VERSION,
    });
    expect(again.data).toBe(first.data);
    expect(await hasConsent(me, "location")).toBe(true);
    expect(await hasConsent(me, "selfie")).toBe(false);

    const rows = await meClient.from("worker_consents").select("worker_id, kind, channel");
    expect(rows.data).toEqual([{ worker_id: me, kind: "location", channel: "worker_app" }]);

    const audit = await admin
      .from("audit_log")
      .select("channel, actor_id")
      .eq("entity", "worker_consents")
      .eq("entity_id", first.data!);
    expect(audit.data?.[0]?.channel).toBe("worker_app");
  });

  it("refuses unknown kinds and versions", async () => {
    for (const [kind, version] of [
      ["fingerprint", VERSION],
      ["location", "v1"],
    ]) {
      const { error } = await meClient.rpc("accept_worker_consent", {
        p_organisation_id: owner.orgId,
        p_kind: kind!,
        p_notice_version: version!,
      });
      expect(error?.code).toBe("MLCN3");
    }
  });

  it("withdrawing closes the open consent; agreeing again adds a new row", async () => {
    const withdrawn = await meClient.rpc("withdraw_worker_consent", {
      p_organisation_id: owner.orgId,
      p_kind: "location",
    });
    expect(withdrawn.data).toBe(true);
    expect(await hasConsent(me, "location")).toBe(false);
    const twice = await meClient.rpc("withdraw_worker_consent", {
      p_organisation_id: owner.orgId,
      p_kind: "location",
    });
    expect(twice.data).toBe(false);

    const again = await meClient.rpc("accept_worker_consent", {
      p_organisation_id: owner.orgId,
      p_kind: "location",
      p_notice_version: VERSION,
    });
    expect(again.error).toBeNull();
    const history = await meClient
      .from("worker_consents")
      .select("withdrawn_at")
      .eq("kind", "location")
      .order("accepted_at");
    expect(history.data).toHaveLength(2);
    expect(history.data![0]!.withdrawn_at).not.toBeNull();
    expect(history.data![1]!.withdrawn_at).toBeNull();
    expect(await hasConsent(me, "location")).toBe(true);
  });

  it("is insert-only: the worker can't insert, edit or delete rows directly", async () => {
    const insert = await meClient.from("worker_consents").insert({
      organisation_id: owner.orgId,
      worker_id: me,
      kind: "selfie",
      notice_version: VERSION,
    });
    expect(insert.error?.code).toBe(PERMISSION_DENIED);
    const update = await meClient
      .from("worker_consents")
      .update({ notice_version: "2020-01-01.1" })
      .eq("worker_id", me);
    expect(update.error?.code).toBe(PERMISSION_DENIED);
    const del = await meClient.from("worker_consents").delete().eq("worker_id", me);
    expect(del.error?.code).toBe(PERMISSION_DENIED);
  });

  it("is never written with the secret key, and never edited or deleted by anyone", async () => {
    const { data } = await admin
      .from("worker_consents")
      .select("id, withdrawn_at")
      .eq("worker_id", me)
      .not("withdrawn_at", "is", null)
      .single();
    const forged = await admin.from("worker_consents").insert({
      organisation_id: owner.orgId,
      worker_id: me,
      kind: "selfie",
      notice_version: VERSION,
    });
    expect(forged.error?.code).toBe(PERMISSION_DENIED);
    const keyUpdate = await admin
      .from("worker_consents")
      .update({ withdrawn_at: null })
      .eq("id", data!.id);
    expect(keyUpdate.error?.code).toBe(PERMISSION_DENIED);
    // The database owner is held by the guard trigger.
    await expect(
      db.query("update public.worker_consents set withdrawn_at = null where id = $1", [data!.id]),
    ).rejects.toMatchObject({ code: "MLCN3" });
    await expect(
      db.query("delete from public.worker_consents where id = $1", [data!.id]),
    ).rejects.toMatchObject({ code: "MLCN3" });
  });

  it("a colleague sees only their own; HR, admin and owner see all; others none", async () => {
    const colleagueRows = await colleagueClient.from("worker_consents").select("worker_id");
    expect(colleagueRows.data).toEqual([]);
    for (const reader of [owner, staff.admin, staff.hr]) {
      const { data } = await reader.client.from("worker_consents").select("worker_id");
      expect(data?.length).toBeGreaterThanOrEqual(2);
    }
    for (const reader of [staff.finance, staff.ops, staff.lineManager]) {
      const { data } = await reader.client.from("worker_consents").select("worker_id");
      expect(data).toEqual([]);
    }
  });

  it("refuses another company's id and managers who are not the worker", async () => {
    const cross = await otherClient.rpc("accept_worker_consent", {
      p_organisation_id: owner.orgId,
      p_kind: "selfie",
      p_notice_version: VERSION,
    });
    expect(cross.error?.code).toBe("MLCN1");
    const crossWithdraw = await otherClient.rpc("withdraw_worker_consent", {
      p_organisation_id: owner.orgId,
      p_kind: "location",
    });
    expect(crossWithdraw.error?.code).toBe("MLCN1");
    expect(await hasConsent(me, "location")).toBe(true);
    const manager = await staff.hr.client.rpc("accept_worker_consent", {
      p_organisation_id: owner.orgId,
      p_kind: "selfie",
      p_notice_version: VERSION,
    });
    expect(manager.error?.code).toBe("MLCN1");
    const anon = await anonClient().rpc("accept_worker_consent", {
      p_organisation_id: owner.orgId,
      p_kind: "selfie",
      p_notice_version: VERSION,
    });
    expect(anon.error).not.toBeNull();
  });

  it("refuses a worker who has left", async () => {
    const leaver = await addWorker();
    const client = await workerSession(leaver);
    await db.query(
      "update public.workers set status = 'ended', end_date = current_date where id = $1",
      [leaver],
    );
    const { error } = await client.rpc("accept_worker_consent", {
      p_organisation_id: owner.orgId,
      p_kind: "location",
      p_notice_version: VERSION,
    });
    expect(error?.code).toBe("MLCN2");
  }, 60_000);

  it("worker_has_consent is not callable from the Data API", async () => {
    const { rows } = await db.query<{ ok: boolean }>(
      "select has_function_privilege('authenticated', 'private.worker_has_consent(uuid, uuid, text)', 'execute') as ok",
    );
    expect(rows[0]!.ok).toBe(false);
  });
});

describe("inbox_items", () => {
  let mine: string;
  let theirs: string;

  beforeAll(async () => {
    const inserted = await admin
      .from("inbox_items")
      .insert([
        {
          organisation_id: owner.orgId,
          worker_id: me,
          kind: "general",
          title: "Roster published",
          body: "Your shifts for next week are ready.",
          link_path: "/m/shifts",
        },
        {
          organisation_id: owner.orgId,
          worker_id: colleague,
          kind: "general",
          title: "Welcome",
          body: "Hello from HR.",
        },
      ])
      .select("id, worker_id");
    expect(inserted.error).toBeNull();
    mine = inserted.data!.find((r) => r.worker_id === me)!.id;
    theirs = inserted.data!.find((r) => r.worker_id === colleague)!.id;
  });

  it("the worker reads only their own items", async () => {
    const { data } = await meClient.from("inbox_items").select("id");
    expect(data).toEqual([{ id: mine }]);
    const other = await meClient.from("inbox_items").select("id").eq("id", theirs);
    expect(other.data).toEqual([]);
  });

  it("the worker marks an item read: the time is the server's, set once, never cleared", async () => {
    const past = "2020-01-01T00:00:00Z";
    const marked = await meClient
      .from("inbox_items")
      .update({ read_at: past })
      .eq("id", mine)
      .select("read_at")
      .single();
    expect(marked.error).toBeNull();
    const readAt = marked.data!.read_at!;
    expect(new Date(readAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    const cleared = await meClient
      .from("inbox_items")
      .update({ read_at: null })
      .eq("id", mine)
      .select("read_at")
      .single();
    expect(cleared.data!.read_at).toBe(readAt);
  });

  it("the worker can't change anything else, add items, delete them or mark a colleague's", async () => {
    const title = await meClient.from("inbox_items").update({ title: "Changed" }).eq("id", mine);
    expect(title.error?.code).toBe(PERMISSION_DENIED);
    const insert = await meClient.from("inbox_items").insert({
      organisation_id: owner.orgId,
      worker_id: me,
      kind: "general",
      title: "Fake",
      body: "Fake",
    });
    expect(insert.error?.code).toBe(PERMISSION_DENIED);
    const del = await meClient.from("inbox_items").delete().eq("id", mine);
    expect(del.error?.code).toBe(PERMISSION_DENIED);
    const colleagues = await meClient
      .from("inbox_items")
      .update({ read_at: new Date().toISOString() })
      .eq("id", theirs)
      .select("id");
    expect(colleagues.data).toEqual([]);
    const { data } = await admin.from("inbox_items").select("read_at").eq("id", theirs).single();
    expect(data!.read_at).toBeNull();
  });

  it("owner, admin and HR read items without changing them; other managers see none", async () => {
    for (const reader of [owner, staff.admin, staff.hr]) {
      const { data } = await reader.client.from("inbox_items").select("id");
      expect(data?.map((r) => r.id).sort()).toEqual([mine, theirs].sort());
      const update = await reader.client
        .from("inbox_items")
        .update({ read_at: new Date().toISOString() })
        .eq("id", theirs)
        .select("id");
      expect(update.data ?? []).toEqual([]);
    }
    for (const reader of [staff.finance, staff.ops, staff.lineManager]) {
      const { data } = await reader.client.from("inbox_items").select("id");
      expect(data).toEqual([]);
    }
  });

  it("refuses web addresses, outside links and markup", async () => {
    for (const row of [
      { title: "Hi", body: "Go to https://evil.example", link_path: null },
      { title: "Hi", body: "Visit www.evil.example", link_path: null },
      { title: "Hi", body: "Fine", link_path: "https://evil.example" },
      { title: "Hi", body: "Fine", link_path: "//evil.example" },
      { title: "Hi", body: "Fine", link_path: "/app/people" },
      { title: "Hi", body: "Fine", link_path: "/m/../app" },
      { title: "<b>Hi</b>", body: "Fine", link_path: null },
    ]) {
      const { error } = await admin
        .from("inbox_items")
        .insert({ organisation_id: owner.orgId, worker_id: me, kind: "general", ...row });
      expect(error?.code, JSON.stringify(row)).toBe("23514");
    }
  });

  it("is never edited or deleted with the secret key", async () => {
    const edit = await admin.from("inbox_items").update({ body: "Changed" }).eq("id", mine);
    expect(edit.error?.code).toBe("MLIB1");
    const del = await admin.from("inbox_items").delete().eq("id", mine);
    expect(del.error?.code).toBe("MLIB1");
  });

  it("claim_inbox_email applies the company and overall caps, once per item", async () => {
    const forbidden = await meClient.rpc("claim_inbox_email", {
      p_item_id: mine,
      p_org_cap: 10,
      p_global_cap: 10,
    });
    expect(forbidden.error?.code).toBe(PERMISSION_DENIED);

    const { rows: before } = await db.query<{ n: string }>(
      "select count(*) as n from public.inbox_items where emailed_at > now() - interval '24 hours'",
    );
    const sentSoFar = Number(before[0]!.n);
    const items = await admin
      .from("inbox_items")
      .insert(
        [1, 2, 3].map((n) => ({
          organisation_id: owner.orgId,
          worker_id: me,
          kind: "general",
          title: `Notice ${n}`,
          body: "Body",
        })),
      )
      .select("id");
    const ids = items.data!.map((r) => r.id);
    const claim = (id: string, orgCap: number, globalCap: number) =>
      admin.rpc("claim_inbox_email", { p_item_id: id, p_org_cap: orgCap, p_global_cap: globalCap });

    expect((await claim(ids[0]!, 1, sentSoFar + 10)).data).toBe(true);
    expect((await claim(ids[0]!, 10, sentSoFar + 10)).data).toBe(false); // already emailed
    expect((await claim(ids[1]!, 1, sentSoFar + 10)).data).toBe(false); // company cap reached
    expect((await claim(ids[1]!, 10, sentSoFar + 1)).data).toBe(false); // overall cap reached
    expect((await claim(ids[1]!, 10, sentSoFar + 10)).data).toBe(true);
    const stamped = await admin.from("inbox_items").select("emailed_at").in("id", ids);
    expect(stamped.data!.filter((r) => r.emailed_at !== null)).toHaveLength(2);
  });
});

describe("attendance settings", () => {
  async function save(
    client: Client,
    patch: { late_grace_minutes?: number; no_show_after_minutes?: number },
  ) {
    return client.from("organisations").update(patch).eq("id", owner.orgId).select("id");
  }

  it("defaults to 10 minutes' grace and a no-show after 60", async () => {
    const { data } = await owner.client
      .from("organisations")
      .select("late_grace_minutes, no_show_after_minutes")
      .eq("id", owner.orgId)
      .single();
    expect(data).toEqual({ late_grace_minutes: 10, no_show_after_minutes: 60 });
  });

  it("owner and admin change them, and each change is audited", async () => {
    const byOwner = await save(owner.client, { late_grace_minutes: 15 });
    expect(byOwner.error).toBeNull();
    expect(byOwner.data).toHaveLength(1);
    const byAdmin = await save(staff.admin.client, { no_show_after_minutes: 90 });
    expect(byAdmin.data).toHaveLength(1);
    const audit = await admin
      .from("audit_log")
      .select("after")
      .eq("entity", "organisations")
      .eq("entity_id", owner.orgId)
      .order("at", { ascending: false })
      .limit(1)
      .single();
    expect((audit.data!.after as Record<string, unknown>).no_show_after_minutes).toBe(90);
  });

  it("refuses values out of range", async () => {
    for (const patch of [
      { late_grace_minutes: -1 },
      { late_grace_minutes: 121 },
      { no_show_after_minutes: 14 },
      { no_show_after_minutes: 481 },
      { late_grace_minutes: 100, no_show_after_minutes: 30 },
    ]) {
      const { error } = await save(owner.client, patch);
      expect(error?.code, JSON.stringify(patch)).toBe("23514");
    }
  });

  it("other roles change nothing", async () => {
    for (const user of [staff.hr, staff.finance, staff.ops, staff.lineManager]) {
      const { data } = await save(user.client, { late_grace_minutes: 0 });
      expect(data ?? []).toEqual([]);
    }
    const workerTry = await save(meClient, { late_grace_minutes: 0 });
    expect(workerTry.data ?? []).toEqual([]);
    const { data } = await admin
      .from("organisations")
      .select("late_grace_minutes")
      .eq("id", owner.orgId)
      .single();
    expect(data!.late_grace_minutes).toBe(15);
  });
});
