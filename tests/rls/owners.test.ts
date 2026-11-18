/**
 * Slice 1.13: several owners and hand-over (owner request, 18 Nov 2026). One owner alone adds an
 * owner; with two or more owners, adding, removing or demoting an owner (stepping down included)
 * needs a different owner's approval. The last owner can never go, workers never become owners,
 * and nothing reaches another company. Every rule is checked in the database, for every client.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  adminClient,
  anonClient,
  createTenantUser,
  createTestUser,
  type Client,
  type TenantUser,
  type TestUser,
} from "./helpers/supabase";

const PERMISSION_DENIED = "42501";
const LAST_OWNER = "MLOW1";
const OWN_REQUEST = "MLOW2";
const NOT_ELIGIBLE = "MLOW3";
const DECIDED = "MLOW4";
const OUT_OF_DATE = "MLOW5";
const NEEDS_APPROVAL = "MLOW6";
const ALREADY_WAITING = "MLOW7";
const WORKER_LOGIN = "MLTM2";
const OWN_MEMBERSHIP = "MLTM6";
const OWNER_PROTECTED = "MLTM7";

type Role = "owner" | "admin" | "hr" | "finance" | "ops_manager" | "line_manager" | "worker";

let admin: Client;

async function add(orgId: string, user: TestUser, role: Role, extra: Record<string, unknown> = {}) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role, ...extra });
  if (error) throw new Error(error.message);
}

async function membershipId(userId: string, orgId: string): Promise<string> {
  const { data, error } = await admin
    .from("memberships")
    .select("id")
    .eq("user_id", userId)
    .eq("organisation_id", orgId)
    .single();
  if (error) throw new Error(error.message);
  return data.id;
}

async function roleOf(userId: string, orgId: string) {
  const { data } = await admin
    .from("memberships")
    .select("role")
    .eq("user_id", userId)
    .eq("organisation_id", orgId)
    .maybeSingle();
  return data?.role ?? null;
}

async function request(
  by: TestUser,
  orgId: string,
  args: {
    kind: "add" | "invite" | "remove" | "demote";
    membershipId?: string;
    email?: string;
    newRole?: "admin" | "hr" | "finance" | "ops_manager" | "line_manager";
  },
) {
  const { data, error } = await by.client.rpc("request_owner_change", {
    p_organisation_id: orgId,
    p_kind: args.kind,
    p_membership_id: args.membershipId,
    p_email: args.email,
    p_new_role: args.newRole,
  });
  return { row: data?.[0], error };
}

async function decide(by: TestUser, orgId: string, id: string, decision: string) {
  const { data, error } = await by.client.rpc("decide_owner_change", {
    p_organisation_id: orgId,
    p_change_id: id,
    p_decision: decision,
  });
  return { row: data?.[0], error };
}

/** A company with `count` owners (the founder plus count - 1 more added directly). */
async function companyWithOwners(label: string, count: number) {
  const founder = await createTenantUser(`${label}-o1`, `${label} Ltd`);
  const owners: TestUser[] = [founder];
  for (let i = 2; i <= count; i++) {
    const user = await createTestUser(`${label}-o${i}`);
    await add(founder.orgId, user, "owner");
    owners.push(user);
  }
  return { orgId: founder.orgId, founder, owners };
}

beforeAll(() => {
  admin = adminClient();
});

describe("one owner", () => {
  it("makes an existing manager an owner alone, audited", async () => {
    const { orgId, founder } = await companyWithOwners("own-one", 1);
    const hr = await createTestUser("own-one-hr");
    await add(orgId, hr, "hr");

    const { row, error } = await request(founder, orgId, {
      kind: "add",
      membershipId: await membershipId(hr.id, orgId),
    });
    expect(error).toBeNull();
    expect(row?.change_status).toBe("approved");
    expect(await roleOf(hr.id, orgId)).toBe("owner");

    const { data: change } = await admin
      .from("owner_changes")
      .select("single_owner, approved_by, requested_by, owners_at_request")
      .eq("id", row!.change_id)
      .single();
    expect(change).toEqual({
      single_owner: true,
      approved_by: null,
      requested_by: founder.id,
      owners_at_request: 1,
    });
    const { data: audit } = await admin
      .from("audit_log")
      .select("action, actor_id")
      .eq("organisation_id", orgId)
      .in("action", ["owner_changes.insert", "memberships.update"]);
    expect(audit).toEqual(
      expect.arrayContaining([
        { action: "owner_changes.insert", actor_id: founder.id },
        { action: "memberships.update", actor_id: founder.id },
      ]),
    );
  });

  it("invites someone as owner alone; they join as owner", async () => {
    const { orgId, founder } = await companyWithOwners("own-inv", 1);
    const invitee = await createTestUser("own-inv-new");
    const { row, error } = await request(founder, orgId, { kind: "invite", email: invitee.email });
    expect(error).toBeNull();
    expect(row?.change_status).toBe("approved");
    expect(row?.invite_token).toMatch(/^[0-9a-f]{64}$/);

    const accept = await invitee.client.rpc("accept_membership_invite", {
      p_token: row!.invite_token,
    });
    expect(accept.error).toBeNull();
    expect(await roleOf(invitee.id, orgId)).toBe("owner");
  });

  it("can't remove or demote themselves: the last owner always stays", async () => {
    const { orgId, founder } = await companyWithOwners("own-last", 1);
    const own = await membershipId(founder.id, orgId);
    const stepDown = await request(founder, orgId, {
      kind: "demote",
      membershipId: own,
      newRole: "admin",
    });
    expect(stepDown.error?.code).toBe(LAST_OWNER);
    const remove = await request(founder, orgId, { kind: "remove", membershipId: own });
    expect(remove.error?.code).toBe(OWN_MEMBERSHIP);
    // The 1.12 functions never touch an owner.
    const demote = await founder.client.rpc("change_member_role", {
      p_organisation_id: orgId,
      p_membership_id: own,
      p_role: "admin",
    });
    expect(demote.error?.code).toBe(OWN_MEMBERSHIP);
    expect(await roleOf(founder.id, orgId)).toBe("owner");
  });

  it("never makes a worker or a client approver an owner", async () => {
    const { orgId, founder } = await companyWithOwners("own-wk", 1);
    const worker = await createTestUser("own-wk-worker");
    const approver = await createTestUser("own-wk-approver");
    await add(orgId, worker, "worker");
    await add(orgId, approver, "client_approver" as Role);
    for (const target of [worker, approver]) {
      const { error } = await request(founder, orgId, {
        kind: "add",
        membershipId: await membershipId(target.id, orgId),
      });
      expect(error?.code).toBe(NOT_ELIGIBLE);
    }
    expect(await roleOf(worker.id, orgId)).toBe("worker");

    // A worker's login can't be invited as owner, and even the secret key can't make one.
    const login = await createTestUser("own-wk-login");
    await admin.auth.admin.updateUserById(login.id, { app_metadata: { login: "worker" } });
    const invite = await request(founder, orgId, { kind: "invite", email: login.email });
    expect(invite.error?.code).toBe(WORKER_LOGIN);
    const flagged = await admin
      .from("memberships")
      .insert({ organisation_id: orgId, user_id: login.id, role: "owner" });
    expect(flagged.error?.message).toMatch(/worker can't be an owner/);
  });

  it("only owners ask: an admin can't add an owner", async () => {
    const { orgId } = await companyWithOwners("own-adm", 1);
    const orgAdmin = await createTestUser("own-adm-admin");
    const hr = await createTestUser("own-adm-hr");
    await add(orgId, orgAdmin, "admin");
    await add(orgId, hr, "hr");
    const { error } = await request(orgAdmin, orgId, {
      kind: "add",
      membershipId: await membershipId(hr.id, orgId),
    });
    expect(error?.code).toBe(PERMISSION_DENIED);
    const self = await request(orgAdmin, orgId, {
      kind: "add",
      membershipId: await membershipId(orgAdmin.id, orgId),
    });
    expect(self.error?.code).toBe(PERMISSION_DENIED);
    expect(await roleOf(hr.id, orgId)).toBe("hr");
    expect(await roleOf(orgAdmin.id, orgId)).toBe("admin");
  });
});

describe("two or more owners", () => {
  let orgId: string;
  let a: TenantUser;
  let b: TestUser;
  let hr: TestUser;
  let orgAdmin: TestUser;

  beforeAll(async () => {
    const company = await companyWithOwners("own-two", 2);
    orgId = company.orgId;
    a = company.founder;
    b = company.owners[1]!;
    hr = await createTestUser("own-two-hr");
    orgAdmin = await createTestUser("own-two-admin");
    await add(orgId, hr, "hr");
    await add(orgId, orgAdmin, "admin");
  });

  it("a single owner can't add an owner directly: it waits for another owner", async () => {
    const hrMembership = await membershipId(hr.id, orgId);
    const { row, error } = await request(a, orgId, { kind: "add", membershipId: hrMembership });
    expect(error).toBeNull();
    expect(row?.change_status).toBe("pending");
    expect(await roleOf(hr.id, orgId)).toBe("hr");

    // Not through PostgREST either: no write grants on owner_changes or memberships.
    const approveDirect = await a.client
      .from("owner_changes")
      .update({ status: "approved", approved_by: b.id })
      .eq("id", row!.change_id);
    expect(approveDirect.error?.code).toBe(PERMISSION_DENIED);
    const insertDirect = await a.client.from("owner_changes").insert({
      organisation_id: orgId,
      kind: "add",
      target_membership_id: hrMembership,
      target_user_id: hr.id,
      owners_at_request: 1,
      single_owner: true,
    });
    expect(insertDirect.error?.code).toBe(PERMISSION_DENIED);
    const promote = await a.client
      .from("memberships")
      .update({ role: "owner" })
      .eq("id", hrMembership);
    expect(promote.error?.code).toBe(PERMISSION_DENIED);

    // A second request for the same person waits behind the first.
    const again = await request(a, orgId, { kind: "add", membershipId: hrMembership });
    expect(again.error?.code).toBe(ALREADY_WAITING);

    // The requester can't approve; an admin can't either; the other owner can.
    expect((await decide(a, orgId, row!.change_id, "approve")).error?.code).toBe(OWN_REQUEST);
    expect((await decide(orgAdmin, orgId, row!.change_id, "approve")).error?.code).toBe(
      PERMISSION_DENIED,
    );
    expect(await roleOf(hr.id, orgId)).toBe("hr");
    const approved = await decide(b, orgId, row!.change_id, "approve");
    expect(approved.error).toBeNull();
    expect(approved.row?.change_status).toBe("approved");
    expect(await roleOf(hr.id, orgId)).toBe("owner");

    const { data: change } = await admin
      .from("owner_changes")
      .select("approved_by, requested_by, single_owner")
      .eq("id", row!.change_id)
      .single();
    expect(change).toEqual({ approved_by: b.id, requested_by: a.id, single_owner: false });
    // Decided once.
    expect((await decide(b, orgId, row!.change_id, "reject")).error?.code).toBe(DECIDED);

    // Even the secret key can't approve as the requester (check constraint).
    const { row: other } = await request(a, orgId, {
      kind: "add",
      membershipId: await membershipId(orgAdmin.id, orgId),
    });
    const selfApprove = await admin
      .from("owner_changes")
      .update({ status: "approved", approved_by: a.id })
      .eq("id", other!.change_id);
    expect(selfApprove.error).not.toBeNull();
    expect((await decide(a, orgId, other!.change_id, "cancel")).error).toBeNull();
    expect(await roleOf(orgAdmin.id, orgId)).toBe("admin");
  });

  it("removing an owner needs another owner; rejected requests change nothing", async () => {
    const hrMembership = await membershipId(hr.id, orgId);
    expect(await roleOf(hr.id, orgId)).toBe("owner");
    const { row, error } = await request(a, orgId, { kind: "remove", membershipId: hrMembership });
    expect(error).toBeNull();
    expect(row?.change_status).toBe("pending");
    // Withdrawing is for the requester only.
    expect((await decide(b, orgId, row!.change_id, "cancel")).error?.code).toBe(PERMISSION_DENIED);
    // The owner being removed may reject it: they are another owner.
    const rejected = await decide(hr, orgId, row!.change_id, "reject");
    expect(rejected.error).toBeNull();
    expect(rejected.row?.change_status).toBe("rejected");
    expect(await roleOf(hr.id, orgId)).toBe("owner");

    // The 1.12 functions refuse owners outright.
    const viaTeam = await a.client.rpc("remove_member", {
      p_organisation_id: orgId,
      p_membership_id: hrMembership,
    });
    expect(viaTeam.error?.code).toBe(OWNER_PROTECTED);

    const { row: again } = await request(a, orgId, { kind: "remove", membershipId: hrMembership });
    const approved = await decide(b, orgId, again!.change_id, "approve");
    expect(approved.error).toBeNull();
    expect(await roleOf(hr.id, orgId)).toBeNull();
  });

  it("an owner steps down only with another owner's approval", async () => {
    const own = await membershipId(b.id, orgId);
    const { row, error } = await request(b, orgId, {
      kind: "demote",
      membershipId: own,
      newRole: "admin",
    });
    expect(error).toBeNull();
    expect(row?.change_status).toBe("pending");
    expect(await roleOf(b.id, orgId)).toBe("owner");
    expect((await decide(b, orgId, row!.change_id, "approve")).error?.code).toBe(OWN_REQUEST);
    const approved = await decide(a, orgId, row!.change_id, "approve");
    expect(approved.error).toBeNull();
    expect(await roleOf(b.id, orgId)).toBe("admin");

    // Now a is the last owner: stepping down is refused, whoever asks.
    const last = await request(a, orgId, {
      kind: "demote",
      membershipId: await membershipId(a.id, orgId),
      newRole: "admin",
    });
    expect(last.error?.code).toBe(LAST_OWNER);
  });
});

describe("approval checks the company as it is", () => {
  it("refuses a request whose owner was demoted meanwhile", async () => {
    const { orgId, owners } = await companyWithOwners("own-stale", 3);
    const [a, b, c] = owners as [TestUser, TestUser, TestUser];
    const hr = await createTestUser("own-stale-hr");
    await add(orgId, hr, "hr");
    const { row } = await request(a, orgId, {
      kind: "add",
      membershipId: await membershipId(hr.id, orgId),
    });
    const { row: demoteA } = await request(b, orgId, {
      kind: "demote",
      membershipId: await membershipId(a.id, orgId),
      newRole: "hr",
    });
    expect((await decide(c, orgId, demoteA!.change_id, "approve")).error).toBeNull();
    const stale = await decide(b, orgId, row!.change_id, "approve");
    expect(stale.error?.code).toBe(OUT_OF_DATE);
    expect(await roleOf(hr.id, orgId)).toBe("hr");
  });

  it("an owner invite sent by a single owner stops working once there are two owners", async () => {
    const { orgId, founder } = await companyWithOwners("own-race", 1);
    const invitee = await createTestUser("own-race-new");
    const hr = await createTestUser("own-race-hr");
    await add(orgId, hr, "hr");
    const { row } = await request(founder, orgId, { kind: "invite", email: invitee.email });
    // Still one owner, so the founder adds a second owner alone too.
    const added = await request(founder, orgId, {
      kind: "add",
      membershipId: await membershipId(hr.id, orgId),
    });
    expect(added.row?.change_status).toBe("approved");

    const accept = await invitee.client.rpc("accept_membership_invite", {
      p_token: row!.invite_token,
    });
    expect(accept.error?.code).toBe(NEEDS_APPROVAL);
    expect(await roleOf(invitee.id, orgId)).toBeNull();
    // Resending it is refused for the same reason.
    const { data: invite } = await admin
      .from("membership_invites")
      .select("id")
      .eq("owner_change_id", row!.change_id)
      .single();
    const resend = await founder.client.rpc("resend_membership_invite", {
      p_organisation_id: orgId,
      p_invite_id: invite!.id,
    });
    expect(resend.error?.code).toBe(NEEDS_APPROVAL);

    // Asked again with two owners: approved by the other owner, the new link works.
    const { row: asked } = await request(founder, orgId, { kind: "invite", email: invitee.email });
    expect(asked?.change_status).toBe("pending");
    expect(asked?.invite_token).toBeNull();
    const approved = await decide(hr, orgId, asked!.change_id, "approve");
    expect(approved.row?.invite_token).toMatch(/^[0-9a-f]{64}$/);
    const joined = await invitee.client.rpc("accept_membership_invite", {
      p_token: approved.row!.invite_token,
    });
    expect(joined.error).toBeNull();
    expect(await roleOf(invitee.id, orgId)).toBe("owner");
  });

  it("admins can't resend or cancel an owner invite", async () => {
    const { orgId, founder } = await companyWithOwners("own-adm-inv", 1);
    const orgAdmin = await createTestUser("own-adm-inv-admin");
    await add(orgId, orgAdmin, "admin");
    const { row } = await request(founder, orgId, {
      kind: "invite",
      email: `owner-${crypto.randomUUID()}@example.test`,
    });
    const { data: invite } = await admin
      .from("membership_invites")
      .select("id")
      .eq("owner_change_id", row!.change_id)
      .single();
    for (const fn of ["resend_membership_invite", "revoke_membership_invite"] as const) {
      const { error } = await orgAdmin.client.rpc(fn, {
        p_organisation_id: orgId,
        p_invite_id: invite!.id,
      });
      expect(error?.code).toBe(PERMISSION_DENIED);
    }
  });
});

describe("other companies", () => {
  it("can't ask for, decide or read another company's owner changes", async () => {
    const victim = await companyWithOwners("own-victim", 2);
    const attacker = await createTenantUser("own-attacker", "Attacker Ltd");
    const victimHr = await createTestUser("own-victim-hr");
    await add(victim.orgId, victimHr, "hr");
    const hrMembership = await membershipId(victimHr.id, victim.orgId);
    const { row } = await request(victim.founder, victim.orgId, {
      kind: "add",
      membershipId: hrMembership,
    });

    for (const org of [victim.orgId, attacker.orgId]) {
      const asked = await request(attacker, org, { kind: "add", membershipId: hrMembership });
      expect(asked.error).not.toBeNull();
      const decided = await decide(attacker, org, row!.change_id, "approve");
      expect(decided.error).not.toBeNull();
    }
    const { data } = await attacker.client
      .from("owner_changes")
      .select("id")
      .eq("organisation_id", victim.orgId);
    expect(data).toEqual([]);
    expect(await roleOf(victimHr.id, victim.orgId)).toBe("hr");
    const { data: still } = await admin
      .from("owner_changes")
      .select("status")
      .eq("id", row!.change_id)
      .single();
    expect(still?.status).toBe("pending");
  });
});

describe("an address confirmed after the invite", () => {
  it("joins only once a password was chosen from an email link (MLPW1)", async () => {
    const owner = await createTenantUser("own-pw", "Password Ltd");
    const email = `rls-own-pw-new-${crypto.randomUUID()}@example.test`;
    const { data: token, error } = await owner.client.rpc("create_membership_invite", {
      p_organisation_id: owner.orgId,
      p_email: email,
      p_role: "hr",
    });
    expect(error).toBeNull();

    // Someone signed the address up with their own password; it was confirmed after the invite.
    const password = `${crypto.randomUUID()}a1`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    const client = anonClient();
    expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
    const refused = await client.rpc("accept_membership_invite", { p_token: token! });
    expect(refused.error?.code).toBe("MLPW1");
    expect(await roleOf(created.data.user!.id, owner.orgId)).toBeNull();

    // The server records a password chosen from an email link; then it joins.
    await admin.auth.admin.updateUserById(created.data.user!.id, {
      app_metadata: { password_set_at: new Date(Date.now() + 1000).toISOString() },
    });
    const accepted = await client.rpc("accept_membership_invite", { p_token: token! });
    expect(accepted.error).toBeNull();
    expect(await roleOf(created.data.user!.id, owner.orgId)).toBe("hr");
  });
});

describe("history can't be rewritten", () => {
  it("the secret key reads owner changes but can't write, delete or forge them", async () => {
    const { orgId, founder } = await companyWithOwners("own-hist", 1);
    const { row } = await request(founder, orgId, {
      kind: "invite",
      email: `owner-${crypto.randomUUID()}@example.test`,
    });
    const update = await admin
      .from("owner_changes")
      .update({ status: "rejected" })
      .eq("id", row!.change_id);
    expect(update.error?.code).toBe(PERMISSION_DENIED);
    const del = await admin.from("owner_changes").delete().eq("id", row!.change_id);
    expect(del.error?.code).toBe(PERMISSION_DENIED);
    const { data } = await admin.from("owner_changes").select("status").eq("id", row!.change_id);
    expect(data).toEqual([{ status: "approved" }]);
  });
});
