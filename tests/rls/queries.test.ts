/**
 * Slice 4.6 against the real database: queries (staff_queries) and their replies
 * (staff_query_replies), docs/PHASE_4.md 4.6.
 * - The accept line: a line manager raises a lateness query with a reply-by date, the worker
 *   replies from their own session, and both show to owner and HR (the HR file).
 * - Who reads which query: owner, admin and hr all; the worker's current line manager; the raiser
 *   while still a manager; the worker their own. Not ops_manager, finance, another line manager,
 *   another worker or another company, and not a former line manager who didn't raise it.
 * - Who writes: raise (line manager for reportees only, hr, admin, owner; never about yourself;
 *   not for a leaver; reply-by today to 60 days; plain text), reply (the worker only to their own;
 *   a manager's follow-up), close, withdraw (raiser only); closed queries take no replies.
 * - Insert-only replies and never-deleted queries, for every role, the secret key and the
 *   database owner (update, delete and truncate).
 * - The daily reminder claim: once per query, server only.
 * - Untrusted sessions and anon get nothing.
 * Cross-organisation isolation of both tables lives in isolation.test.ts (tables/staff_queries.ts).
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays, lagosToday } from "@/lib/dates";
import type { Database } from "@/types/db";

import {
  adminClient,
  anonClient,
  createTenantUser,
  createTestUser,
  markPasswordTrusted,
  pgClient,
  type Client,
  type TenantUser,
  type TestUser,
} from "./helpers/supabase";

type Role = Database["public"]["Enums"]["membership_role"];

const PERMISSION_DENIED = "42501";
const PIN_HASH = `s1$k1$${"A".repeat(22)}$${"B".repeat(43)}`;
const TODAY = lagosToday();
const REPLY_BY = addDays(TODAY, 3);

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
const staff = {} as Record<
  "admin" | "hr" | "finance" | "ops" | "lm" | "lm2" | "otherLm" | "supervisor",
  TestUser
>;
const membership = {} as Record<"lm" | "lm2" | "otherLm", string>;
let counter = 0;
const W = {} as Record<"musa" | "ada" | "leaver" | "supervisor" | "foreign", string>;
let musaClient: Client;
let adaClient: Client;
let foreignClient: Client;

async function addMember(
  user: TestUser,
  role: Role,
  orgId = owner.orgId,
  workerId?: string,
): Promise<string> {
  const { data, error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role, worker_id: workerId ?? null })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

async function addWorker(
  orgId = owner.orgId,
  extra: Partial<Database["public"]["Tables"]["workers"]["Insert"]> = {},
): Promise<string> {
  counter += 1;
  const { data, error } = await admin
    .from("workers")
    .insert({
      organisation_id: orgId,
      staff_id: `SQ-${String(counter).padStart(4, "0")}`,
      first_name: "Musa",
      last_name: `Ibrahim ${counter}`,
      employment_type: "permanent",
      start_date: "2025-01-06",
      ...extra,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

/** An invited worker who has set a PIN, with a session opened the way the server does it. */
async function workerSession(workerId: string, orgId: string, inviter: TestUser) {
  const invite = await inviter.client.rpc("create_worker_invites", {
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

interface RaiseInput {
  workerId?: string;
  kind?: string;
  subject?: string;
  body?: string;
  replyBy?: string;
  orgId?: string;
}

function raise(client: Client, input: RaiseInput = {}) {
  return client.rpc("raise_staff_query", {
    p_organisation_id: input.orgId ?? owner.orgId,
    p_worker_id: input.workerId ?? W.musa,
    p_kind: input.kind ?? "lateness",
    p_subject: input.subject ?? "Lateness on 23 October",
    p_body: input.body ?? "You clocked in at 06:41 for your 06:00 shift at Gate A. Please explain.",
    p_reply_by: input.replyBy ?? REPLY_BY,
  });
}

async function raised(client: Client, input: RaiseInput = {}): Promise<string> {
  const { data, error } = await raise(client, input);
  expect(error).toBeNull();
  return data!;
}

function reply(client: Client, queryId: string, body = "The BRT was stopped at Mile 2.") {
  return client.rpc("reply_to_staff_query", {
    p_organisation_id: owner.orgId,
    p_query_id: queryId,
    p_body: body,
  });
}

async function visibleQueryIds(client: Client): Promise<string[]> {
  const { data, error } = await client.from("staff_queries").select("id");
  expect(error).toBeNull();
  return (data ?? []).map((r) => r.id);
}

async function visibleReplyIds(client: Client): Promise<string[]> {
  const { data, error } = await client.from("staff_query_replies").select("query_id");
  expect(error).toBeNull();
  return (data ?? []).map((r) => r.query_id);
}

/** Runs `sql` as the database owner and returns the error code, or null. */
async function ownerError(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("sq-owner", "Queries Owner Ltd");
  other = await createTenantUser("sq-other", "Queries Other Ltd");
  staff.admin = await createTestUser("sq-admin", "Ada Admin");
  staff.hr = await createTestUser("sq-hr", "Halima Hr");
  staff.finance = await createTestUser("sq-finance");
  staff.ops = await createTestUser("sq-ops");
  staff.lm = await createTestUser("sq-lm", "Kola Adebayo");
  staff.lm2 = await createTestUser("sq-lm2", "Ngozi Eze");
  staff.otherLm = await createTestUser("sq-other-lm");
  staff.supervisor = await createTestUser("sq-supervisor");
  await addMember(staff.admin, "admin");
  await addMember(staff.hr, "hr");
  await addMember(staff.finance, "finance");
  await addMember(staff.ops, "ops_manager");
  membership.lm = await addMember(staff.lm, "line_manager");
  membership.lm2 = await addMember(staff.lm2, "line_manager");
  membership.otherLm = await addMember(staff.otherLm, "line_manager", other.orgId);

  W.musa = await addWorker(owner.orgId, { line_manager_membership_id: membership.lm });
  W.ada = await addWorker(owner.orgId, { line_manager_membership_id: membership.lm2 });
  W.leaver = await addWorker(owner.orgId, {
    line_manager_membership_id: membership.lm,
    status: "ended",
    end_date: "2026-10-31",
  });
  // A line manager who is also an employee, reporting to lm.
  W.supervisor = await addWorker(owner.orgId, { line_manager_membership_id: membership.lm });
  await addMember(staff.supervisor, "line_manager", owner.orgId, W.supervisor);
  W.foreign = await addWorker(other.orgId, { line_manager_membership_id: membership.otherLm });

  const hrMember = await createTestUser("sq-other-hr");
  await addMember(hrMember, "hr", other.orgId);
  musaClient = await workerSession(W.musa, owner.orgId, staff.hr);
  adaClient = await workerSession(W.ada, owner.orgId, staff.hr);
  foreignClient = await workerSession(W.foreign, other.orgId, hrMember);
});

afterAll(async () => {
  await db?.end();
});

describe("the accept line", () => {
  it("a line manager raises a lateness query, the worker replies, both show on the HR file", async () => {
    const queryId = await raised(staff.lm.client);

    const asWorker = await musaClient
      .from("staff_queries")
      .select("id, kind, reply_by, status, raised_by_name")
      .eq("id", queryId);
    expect(asWorker.data).toEqual([
      {
        id: queryId,
        kind: "lateness",
        reply_by: REPLY_BY,
        status: "awaiting_reply",
        raised_by_name: "Kola Adebayo",
      },
    ]);

    const sent = await reply(musaClient, queryId);
    expect(sent.error).toBeNull();
    expect(sent.data).toMatchObject({ query_id: queryId, worker_id: W.musa, author_role: "worker" });

    for (const reader of [owner, staff.hr, staff.lm]) {
      const { data } = await reader.client
        .from("staff_queries")
        .select("status, first_replied_at, staff_query_replies ( author_role, body )")
        .eq("id", queryId)
        .single();
      expect(data?.status).toBe("replied");
      expect(data?.first_replied_at).not.toBeNull();
      expect(data?.staff_query_replies).toEqual([
        { author_role: "worker", body: "The BRT was stopped at Mile 2." },
      ]);
    }

    // The reply is audited on the worker-app channel; the raise as an app event.
    const replyAudit = await admin
      .from("audit_log")
      .select("channel")
      .eq("entity", "staff_query_replies")
      .eq("action", "staff_query_replies.insert");
    expect(replyAudit.data?.map((r) => r.channel)).toContain("worker_app");
    const raisedAudit = await admin
      .from("audit_log")
      .select("actor_id")
      .eq("action", "people.query_raised")
      .eq("entity_id", queryId);
    expect(raisedAudit.data).toEqual([{ actor_id: staff.lm.id }]);
  });
});

describe("who reads which query", () => {
  let lmQuery: string;
  let hrQuery: string;
  let adaQuery: string;
  let foreignQuery: string;

  beforeAll(async () => {
    lmQuery = await raised(staff.lm.client, { subject: "Lateness on 1 November" });
    hrQuery = await raised(staff.hr.client, { kind: "conduct", subject: "Conduct at the gate" });
    adaQuery = await raised(staff.lm2.client, { workerId: W.ada, subject: "Absent on 2 November" });
    await reply(adaClient, adaQuery);
    const foreign = await raise(staff.otherLm.client, {
      orgId: other.orgId,
      workerId: W.foreign,
      subject: "Foreign query",
    });
    expect(foreign.error).toBeNull();
    foreignQuery = foreign.data!;
  });

  it("owner, admin and hr read every query and reply in their company", async () => {
    for (const reader of [owner, staff.admin, staff.hr]) {
      const ids = await visibleQueryIds(reader.client);
      expect(ids).toEqual(expect.arrayContaining([lmQuery, hrQuery, adaQuery]));
      expect(ids).not.toContain(foreignQuery);
      expect(await visibleReplyIds(reader.client)).toContain(adaQuery);
    }
  });

  it("a line manager reads their current reportees' queries only", async () => {
    const lm = await visibleQueryIds(staff.lm.client);
    expect(lm).toEqual(expect.arrayContaining([lmQuery, hrQuery]));
    expect(lm).not.toContain(adaQuery);
    expect(lm).not.toContain(foreignQuery);
    expect(await visibleReplyIds(staff.lm.client)).not.toContain(adaQuery);
    expect(await visibleQueryIds(staff.lm2.client)).toEqual([adaQuery]);
    expect(await visibleReplyIds(staff.lm2.client)).toEqual([adaQuery]);
  });

  it("ops managers, finance and other companies read nothing", async () => {
    for (const reader of [staff.ops, staff.finance, staff.otherLm, other]) {
      const ids = await visibleQueryIds(reader.client);
      expect(ids.filter((id) => [lmQuery, hrQuery, adaQuery].includes(id))).toEqual([]);
      expect(
        (await visibleReplyIds(reader.client)).filter((id) => id === adaQuery),
      ).toEqual([]);
    }
  });

  it("a worker reads only their own queries and replies", async () => {
    const musa = await visibleQueryIds(musaClient);
    expect(musa).toEqual(expect.arrayContaining([lmQuery, hrQuery]));
    expect(musa).not.toContain(adaQuery);
    expect(await visibleQueryIds(adaClient)).toEqual([adaQuery]);
    expect(await visibleReplyIds(musaClient)).not.toContain(adaQuery);
    expect(await visibleQueryIds(foreignClient)).toEqual([foreignQuery]);
  });

  it("a former line manager reads only the queries they raised", async () => {
    const worker = await addWorker(owner.orgId, { line_manager_membership_id: membership.lm });
    const byLm = await raised(staff.lm.client, { workerId: worker, subject: "Raised by Kola" });
    const byHr = await raised(staff.hr.client, { workerId: worker, subject: "Raised by HR" });
    expect(await visibleQueryIds(staff.lm.client)).toEqual(expect.arrayContaining([byLm, byHr]));

    // The worker moves to another line manager.
    const moved = await admin
      .from("workers")
      .update({ line_manager_membership_id: membership.lm2 })
      .eq("id", worker);
    expect(moved.error).toBeNull();

    const former = await visibleQueryIds(staff.lm.client);
    expect(former).toContain(byLm);
    expect(former).not.toContain(byHr);
    expect(await visibleQueryIds(staff.lm2.client)).toEqual(
      expect.arrayContaining([byLm, byHr]),
    );
    // Nor can the former line manager reply to or close the one they didn't raise.
    expect((await reply(staff.lm.client, byHr, "Follow-up")).error?.code).toBe("P0002");

    // Once they hold no manager role, the raiser reads nothing either.
    const demoted = await admin
      .from("memberships")
      .update({ role: "finance" })
      .eq("id", membership.lm);
    expect(demoted.error).toBeNull();
    try {
      expect(await visibleQueryIds(staff.lm.client)).not.toContain(byLm);
    } finally {
      await admin.from("memberships").update({ role: "line_manager" }).eq("id", membership.lm);
    }
  });

  it("an untrusted password session and anon read nothing", async () => {
    const email = `rls-sq-untrusted-${randomUUID()}@example.test`;
    const password = `${randomUUID()}a1`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    const client = anonClient();
    expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
    await addMember({ id: created.data.user!.id, email, client }, "hr");
    expect(await visibleQueryIds(client)).toEqual([]);
    expect((await raise(client)).error?.code).toBe(PERMISSION_DENIED);
    await markPasswordTrusted(created.data.user!.id);
    await client.auth.refreshSession();
    expect((await visibleQueryIds(client)).length).toBeGreaterThan(0);

    const anon = anonClient();
    const select = await anon.from("staff_queries").select("id");
    expect(select.data ?? []).toEqual([]);
    expect((await raise(anon)).error).not.toBeNull();
  });
});

describe("raising", () => {
  it("a line manager raises only for their reportees", async () => {
    expect((await raise(staff.lm.client, { workerId: W.ada })).error?.code).toBe("MLQY2");
    expect((await raise(staff.lm2.client, { workerId: W.ada })).error).toBeNull();
  });

  it("other roles, workers and other companies can't raise", async () => {
    expect((await raise(staff.ops.client)).error?.code).toBe(PERMISSION_DENIED);
    expect((await raise(staff.finance.client)).error?.code).toBe(PERMISSION_DENIED);
    expect((await raise(musaClient, { workerId: W.ada })).error?.code).toBe(PERMISSION_DENIED);
    expect((await raise(other.client)).error?.code).toBe(PERMISSION_DENIED);
    // Another company's worker id, in a company where the caller is HR.
    expect((await raise(staff.hr.client, { workerId: W.foreign })).error?.code).toBe("P0002");
  });

  it("never about yourself, never for a leaver", async () => {
    // A line manager who is also an employee isn't their own reportee.
    const self = await raise(staff.supervisor.client, { workerId: W.supervisor });
    expect(self.error?.code).toBe("MLQY2");
    // HR who is also an employee can't query their own record.
    const hrWorker = await addWorker(owner.orgId);
    const selfHr = await createTestUser("sq-self-hr");
    await addMember(selfHr, "hr", owner.orgId, hrWorker);
    expect((await raise(selfHr.client, { workerId: hrWorker })).error?.code).toBe("MLQY4");
    expect((await raise(staff.lm.client, { workerId: W.leaver })).error?.code).toBe("MLQY3");
  });

  it("takes a reply-by date from today to 60 days ahead", async () => {
    expect((await raise(staff.hr.client, { replyBy: addDays(TODAY, -1) })).error?.code).toBe(
      "MLQY5",
    );
    expect((await raise(staff.hr.client, { replyBy: addDays(TODAY, 61) })).error?.code).toBe(
      "MLQY5",
    );
    expect((await raise(staff.hr.client, { replyBy: TODAY })).error).toBeNull();
    expect((await raise(staff.hr.client, { replyBy: addDays(TODAY, 60) })).error).toBeNull();
  });

  it("takes plain text only, as the inbox rule", async () => {
    for (const input of [
      { subject: "See https://pay.example" },
      { subject: "Pay at acme-pay.com" },
      { body: "Call me on 0803 123 4567 today." },
      { body: "Hello <script>x</script>" },
      { subject: "Two\nlines" },
      { subject: "ab" },
      { body: "x".repeat(2001) },
      { kind: "theft" },
    ]) {
      expect((await raise(staff.hr.client, input)).error?.code, JSON.stringify(input)).toBe("MLQY1");
    }
    expect(
      (await raise(staff.hr.client, { body: "Absent on 21/11/2026 08:00.\nSecond line." })).error,
    ).toBeNull();
  });
});

describe("replies, closing and withdrawing", () => {
  it("a worker replies only to their own query", async () => {
    const queryId = await raised(staff.lm.client);
    expect((await reply(adaClient, queryId)).error?.code).toBe("P0002");
    expect((await reply(foreignClient, queryId)).error?.code).toBe("P0002");
    expect((await reply(staff.ops.client, queryId)).error?.code).toBe("P0002");
    expect((await reply(musaClient, queryId, "See www.example.test")).error?.code).toBe("MLQY1");
    expect((await reply(musaClient, queryId)).error).toBeNull();
    // A second reply is fine; the status stays replied.
    expect((await reply(musaClient, queryId, "And I called at 05:50.")).error).toBeNull();
  });

  it("a manager's follow-up keeps the status and is marked as a manager's", async () => {
    const queryId = await raised(staff.lm.client);
    const followUp = await reply(staff.hr.client, queryId, "Please say who you called.");
    expect(followUp.error).toBeNull();
    expect(followUp.data).toMatchObject({ author_role: "manager" });
    const { data } = await admin
      .from("staff_queries")
      .select("status, staff_query_replies ( author_role, author_name )")
      .eq("id", queryId)
      .single();
    expect(data?.status).toBe("awaiting_reply");
    expect(data?.staff_query_replies).toEqual([{ author_role: "manager", author_name: "Halima Hr" }]);
  });

  it("closes with an outcome; a closed query takes no replies and can't be withdrawn", async () => {
    const queryId = await raised(staff.lm.client);
    await reply(musaClient, queryId);
    const missing = await staff.lm.client.rpc("close_staff_query", {
      p_organisation_id: owner.orgId,
      p_query_id: queryId,
      p_outcome: "",
    });
    expect(missing.error?.code).toBe("MLQY1");
    expect(
      (
        await staff.ops.client.rpc("close_staff_query", {
          p_organisation_id: owner.orgId,
          p_query_id: queryId,
          p_outcome: "Warned.",
        })
      ).error?.code,
    ).toBe(PERMISSION_DENIED);
    const closed = await staff.lm.client.rpc("close_staff_query", {
      p_organisation_id: owner.orgId,
      p_query_id: queryId,
      p_outcome: "Explanation accepted. No further action.",
    });
    expect(closed.error).toBeNull();
    expect(closed.data).toBe(W.musa);
    const { data } = await admin
      .from("staff_queries")
      .select("status, closed_by, closed_at, outcome_note")
      .eq("id", queryId)
      .single();
    expect(data).toMatchObject({
      status: "closed",
      closed_by: staff.lm.id,
      outcome_note: "Explanation accepted. No further action.",
    });
    expect(data?.closed_at).not.toBeNull();
    expect((await reply(musaClient, queryId)).error?.code).toBe("MLQY6");
    const withdraw = await staff.lm.client.rpc("withdraw_staff_query", {
      p_organisation_id: owner.orgId,
      p_query_id: queryId,
      p_reason: "Raised in error.",
    });
    expect(withdraw.error?.code).toBe("MLQY6");
    const audit = await admin
      .from("audit_log")
      .select("reason")
      .eq("action", "people.query_closed")
      .eq("entity_id", queryId);
    expect(audit.data).toEqual([{ reason: "Explanation accepted. No further action." }]);
  });

  it("only the raiser withdraws, with a reason", async () => {
    const queryId = await raised(staff.lm.client);
    const byHr = await staff.hr.client.rpc("withdraw_staff_query", {
      p_organisation_id: owner.orgId,
      p_query_id: queryId,
      p_reason: "Not needed.",
    });
    expect(byHr.error?.code).toBe("MLQY2");
    const byRaiser = await staff.lm.client.rpc("withdraw_staff_query", {
      p_organisation_id: owner.orgId,
      p_query_id: queryId,
      p_reason: "Raised for the wrong day.",
    });
    expect(byRaiser.error).toBeNull();
    const { data } = await admin.from("staff_queries").select("status").eq("id", queryId).single();
    expect(data?.status).toBe("withdrawn");
  });
});

describe("insert-only replies, never-deleted queries", () => {
  let queryId: string;
  let replyId: string;

  beforeAll(async () => {
    queryId = await raised(staff.lm.client);
    const sent = await reply(musaClient, queryId);
    expect(sent.error).toBeNull();
    replyId = (sent.data as { reply_id: string }).reply_id;
  });

  it("no signed-in role can write either table directly", async () => {
    for (const client of [owner.client, staff.hr.client, staff.lm.client, musaClient]) {
      const update = await client
        .from("staff_query_replies")
        .update({ body: "Edited." })
        .eq("id", replyId)
        .select("id");
      expect(update.error?.code).toBe(PERMISSION_DENIED);
      const del = await client.from("staff_query_replies").delete().eq("id", replyId).select("id");
      expect(del.error?.code).toBe(PERMISSION_DENIED);
      const status = await client
        .from("staff_queries")
        .update({ status: "closed" })
        .eq("id", queryId)
        .select("id");
      expect(status.error?.code).toBe(PERMISSION_DENIED);
      const insert = await client.from("staff_query_replies").insert({
        organisation_id: owner.orgId,
        query_id: queryId,
        author_user_id: randomUUID(),
        author_role: "worker",
        author_name: "Planted",
        body: "Planted reply.",
      });
      expect(insert.error?.code).toBe(PERMISSION_DENIED);
    }
  });

  it("the secret key can't change or delete a reply or a query", async () => {
    const update = await admin.from("staff_query_replies").update({ body: "Edited." }).eq("id", replyId);
    expect(update.error?.code).toBe(PERMISSION_DENIED);
    const del = await admin.from("staff_query_replies").delete().eq("id", replyId);
    expect(del.error?.code).toBe(PERMISSION_DENIED);
    const status = await admin.from("staff_queries").update({ status: "closed" }).eq("id", queryId);
    expect(status.error?.code).toBe(PERMISSION_DENIED);
    const gone = await admin.from("staff_queries").delete().eq("id", queryId);
    expect(gone.error?.code).toBe(PERMISSION_DENIED);
  });

  it("not even the database owner can edit, delete or truncate", async () => {
    expect(
      await ownerError("update public.staff_query_replies set body = 'Edited.' where id = $1", [
        replyId,
      ]),
    ).toBe("MLQY0");
    expect(await ownerError("delete from public.staff_query_replies where id = $1", [replyId])).toBe(
      "MLQY0",
    );
    expect(await ownerError("truncate public.staff_query_replies")).toBe("MLQY0");
    expect(
      await ownerError("update public.staff_queries set subject = 'Edited subject' where id = $1", [
        queryId,
      ]),
    ).toBe("MLQY0");
    expect(await ownerError("delete from public.staff_queries where id = $1", [queryId])).toBe(
      "MLQY0",
    );
    expect(await ownerError("truncate public.staff_queries cascade")).toBe("MLQY0");
    // A status move outside the functions' rules: replied back to awaiting a reply.
    expect(
      await ownerError("update public.staff_queries set status = 'awaiting_reply' where id = $1", [
        queryId,
      ]),
    ).toBe("MLQY0");
    // Closing without who and a note.
    expect(
      await ownerError("update public.staff_queries set status = 'closed' where id = $1", [queryId]),
    ).not.toBeNull();
    const { rows } = await db.query<{ n: string }>(
      "select count(*) as n from public.staff_query_replies where id = $1 and body = 'The BRT was stopped at Mile 2.'",
      [replyId],
    );
    expect(rows[0]!.n).toBe("1");
  });

  it("a new query always starts awaiting a reply, whatever the insert says", async () => {
    const { data, error } = await admin
      .from("staff_queries")
      .insert({
        organisation_id: owner.orgId,
        worker_id: W.musa,
        raised_by: staff.hr.id,
        raised_by_name: "Halima Hr",
        kind: "other",
        subject: "Seeded query",
        body: "Seeded by the secret key.",
        reply_by: REPLY_BY,
        status: "closed",
        closed_at: new Date().toISOString(),
        closed_by: staff.hr.id,
        outcome_note: "Pre-closed.",
      })
      .select("status, closed_at, outcome_note")
      .single();
    expect(error).toBeNull();
    expect(data).toEqual({ status: "awaiting_reply", closed_at: null, outcome_note: null });
  });
});

describe("daily reminders", () => {
  it("claims a query due tomorrow once, for the secret key only", async () => {
    const tomorrow = addDays(TODAY, 1);
    const queryId = await raised(staff.hr.client, { replyBy: tomorrow, subject: "Reminder due" });
    const fresh = await raised(staff.hr.client, { replyBy: tomorrow, subject: "Just raised" });
    // Raised yesterday evening: older than 12 hours (written as the owner, triggers off).
    await db.query("begin");
    try {
      await db.query("set local session_replication_role = replica");
      await db.query(
        "update public.staff_queries set raised_at = now() - interval '20 hours' where id = $1",
        [queryId],
      );
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw error;
    }

    expect((await staff.hr.client.rpc("claim_staff_query_reminders", { p_limit: 10 })).error).not.toBeNull();
    const first = await admin.rpc("claim_staff_query_reminders", { p_limit: 500 });
    expect(first.error).toBeNull();
    const ids = (first.data ?? []).map((r) => r.query_id);
    expect(ids).toContain(queryId);
    expect(ids).not.toContain(fresh);
    const claimed = first.data!.find((r) => r.query_id === queryId)!;
    expect(claimed).toEqual({
      query_id: queryId,
      organisation_id: owner.orgId,
      worker_id: W.musa,
      subject: "Reminder due",
      reply_by: tomorrow,
    });
    const again = await admin.rpc("claim_staff_query_reminders", { p_limit: 500 });
    expect((again.data ?? []).map((r) => r.query_id)).not.toContain(queryId);
    // The stamp is set once and never moves.
    expect(
      await ownerError("update public.staff_queries set reminded_at = now() + interval '1 day' where id = $1", [
        queryId,
      ]),
    ).toBe("MLQY0");
  });
});

describe("function grants", () => {
  it("anon can't call the writes, and the private definers aren't reachable", async () => {
    const { rows } = await db.query<Record<string, boolean>>(
      `select
         has_function_privilege('anon', 'public.raise_staff_query(uuid, uuid, text, text, text, date)', 'execute') as anon_raise,
         has_function_privilege('anon', 'public.reply_to_staff_query(uuid, uuid, text)', 'execute') as anon_reply,
         has_function_privilege('authenticated', 'public.claim_staff_query_reminders(integer)', 'execute') as auth_claim,
         has_function_privilege('authenticated', 'private.claim_staff_query_reminders(integer)', 'execute') as auth_claim_private,
         has_function_privilege('anon', 'private.my_staff_query_ids()', 'execute') as anon_ids`,
    );
    expect(rows[0]).toEqual({
      anon_raise: false,
      anon_reply: false,
      auth_claim: false,
      auth_claim_private: false,
      anon_ids: false,
    });
  });
});
