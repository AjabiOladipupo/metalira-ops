/**
 * Slice 1.12: Settings → Team. Owners and admins list managers, invite with one manager role,
 * resend and cancel invites, change roles and remove managers, all through SQL functions that
 * check the team rules for every client and are audited by the row triggers. Nothing here
 * reaches another company.
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
const INVALID = "22023";
const NOT_FOUND = "P0002";
const WORKER_LOGIN = "MLTM2";
const CANCELLED = "MLTM5";
const OWN_MEMBERSHIP = "MLTM6";
const NOT_A_MANAGER = "MLTM8";

let admin: Client;
let owner: TenantUser;
let other: TenantUser;
let orgAdmin: TestUser;
let hr: TestUser;
let finance: TestUser;
let worker: TestUser;

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

async function pendingInviteId(orgId: string, email: string): Promise<string> {
  const { data, error } = await admin
    .from("membership_invites")
    .select("id")
    .eq("organisation_id", orgId)
    .eq("email", email.toLowerCase())
    .is("accepted_at", null)
    .is("revoked_at", null)
    .single();
  if (error) throw new Error(error.message);
  return data.id;
}

async function join(by: TestUser, user: TestUser, role: "admin" | "hr" | "finance") {
  const { data: token, error } = await by.client.rpc("create_membership_invite", {
    p_organisation_id: owner.orgId,
    p_email: user.email,
    p_role: role,
  });
  expect(error).toBeNull();
  const accept = await user.client.rpc("accept_membership_invite", { p_token: token! });
  expect(accept.error).toBeNull();
}

beforeAll(async () => {
  admin = adminClient();
  owner = await createTenantUser("t-owner", "Team Org");
  other = await createTenantUser("t-other", "Other Team Org");
  orgAdmin = await createTestUser("t-admin", "Ada Admin");
  hr = await createTestUser("t-hr", "Hauwa Bello");
  finance = await createTestUser("t-finance", "Femi Adeyemi");
  worker = await createTestUser("t-worker");
  await join(owner, orgAdmin, "admin");
  await join(owner, hr, "hr");
  await join(orgAdmin, finance, "finance");
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: owner.orgId, user_id: worker.id, role: "worker" });
  expect(error).toBeNull();
});

describe("team_members", () => {
  it("lists the managers with their sign-in email, for owners and admins only", async () => {
    for (const viewer of [owner, orgAdmin]) {
      const { data, error } = await viewer.client.rpc("team_members", {
        p_organisation_id: owner.orgId,
      });
      expect(error).toBeNull();
      const rows = (data ?? []).map((r) => ({ email: r.email, role: r.role }));
      expect(rows).toEqual(
        expect.arrayContaining([
          { email: owner.email.toLowerCase(), role: "owner" },
          { email: orgAdmin.email.toLowerCase(), role: "admin" },
          { email: hr.email.toLowerCase(), role: "hr" },
          { email: finance.email.toLowerCase(), role: "finance" },
        ]),
      );
      // Workers are managed in People, not listed here.
      expect(rows.map((r) => r.role)).not.toContain("worker");
    }
    const names = await owner.client.rpc("team_members", { p_organisation_id: owner.orgId });
    expect(names.data?.find((r) => r.role === "hr")?.full_name).toBe("Hauwa Bello");
  });

  it("is refused to other roles and other companies", async () => {
    for (const viewer of [hr, finance, worker, other]) {
      const { data, error } = await viewer.client.rpc("team_members", {
        p_organisation_id: owner.orgId,
      });
      expect(error?.code).toBe(PERMISSION_DENIED);
      expect(data).toBeNull();
    }
  });
});

describe("invites", () => {
  it("a worker's login can't be invited, nor accept an invite, in that company", async () => {
    const create = await owner.client.rpc("create_membership_invite", {
      p_organisation_id: owner.orgId,
      p_email: worker.email,
      p_role: "hr",
    });
    expect(create.error?.code).toBe(WORKER_LOGIN);

    // An invite planted for the worker's address (bypassing the check) still can't be used.
    const token = (await import("node:crypto")).randomBytes(32).toString("hex");
    const planted = await admin.from("membership_invites").insert({
      organisation_id: owner.orgId,
      email: worker.email.toLowerCase(),
      role: "hr",
      token_hash: await sha256(token),
      created_by: owner.id,
    });
    expect(planted.error).toBeNull();
    const accept = await worker.client.rpc("accept_membership_invite", { p_token: token });
    expect(accept.error?.code).toBe(WORKER_LOGIN);
    expect(await roleOf(worker.id, owner.orgId)).toBe("worker");
  });

  it("a worker's login from any company can't be invited or accept", async () => {
    const email = `${crypto.randomUUID()}@workers.metalira.invalid`;
    const password = `${crypto.randomUUID()}a1`;
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { login: "worker" },
    });
    expect(created.error).toBeNull();
    const create = await owner.client.rpc("create_membership_invite", {
      p_organisation_id: owner.orgId,
      p_email: email,
      p_role: "hr",
    });
    expect(create.error?.code).toBe(WORKER_LOGIN);

    // An invite planted for that address still can't be used by the worker's session.
    const token = (await import("node:crypto")).randomBytes(32).toString("hex");
    const planted = await admin.from("membership_invites").insert({
      organisation_id: owner.orgId,
      email,
      role: "hr",
      token_hash: await sha256(token),
      created_by: owner.id,
    });
    expect(planted.error).toBeNull();
    const session = anonClient();
    const signIn = await session.auth.signInWithPassword({ email, password });
    expect(signIn.error).toBeNull();
    const accept = await session.rpc("accept_membership_invite", { p_token: token });
    expect(accept.error?.code).toBe(WORKER_LOGIN);
    expect(await roleOf(created.data.user!.id, owner.orgId)).toBeNull();
  });

  it("resend issues a new link for 7 more days and the old one stops working", async () => {
    const invitee = await createTestUser("t-resend");
    const { data: first } = await owner.client.rpc("create_membership_invite", {
      p_organisation_id: owner.orgId,
      p_email: invitee.email,
      p_role: "finance",
    });
    const inviteId = await pendingInviteId(owner.orgId, invitee.email);
    await admin
      .from("membership_invites")
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("id", inviteId);

    const { data, error } = await orgAdmin.client.rpc("resend_membership_invite", {
      p_organisation_id: owner.orgId,
      p_invite_id: inviteId,
    });
    expect(error).toBeNull();
    const row = data?.[0];
    expect(row?.token).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.token).not.toBe(first);
    expect(row?.invite_role).toBe("finance");
    expect(Date.parse(row!.invite_expires_at)).toBeGreaterThan(Date.now() + 6.9 * 86_400_000);

    const old = await invitee.client.rpc("accept_membership_invite", { p_token: first! });
    expect(old.error?.code).toBe(INVALID);
    const accept = await invitee.client.rpc("accept_membership_invite", { p_token: row!.token });
    expect(accept.error).toBeNull();
    expect(await roleOf(invitee.id, owner.orgId)).toBe("finance");

    // The audit log keeps the resend without the token hash.
    const { data: audit } = await admin
      .from("audit_log")
      .select("actor_id, before, after")
      .eq("action", "membership_invites.update")
      .eq("entity_id", inviteId);
    expect(audit?.some((a) => a.actor_id === orgAdmin.id)).toBe(true);
    expect(JSON.stringify(audit)).not.toMatch(/token_hash/);
  });

  it("an admin can't resend or cancel an admin invite; the owner can", async () => {
    const invitee = await createTestUser("t-admin-invitee");
    await owner.client.rpc("create_membership_invite", {
      p_organisation_id: owner.orgId,
      p_email: invitee.email,
      p_role: "admin",
    });
    const inviteId = await pendingInviteId(owner.orgId, invitee.email);
    const args = { p_organisation_id: owner.orgId, p_invite_id: inviteId };

    expect((await orgAdmin.client.rpc("resend_membership_invite", args)).error?.code).toBe(
      PERMISSION_DENIED,
    );
    expect((await orgAdmin.client.rpc("revoke_membership_invite", args)).error?.code).toBe(
      PERMISSION_DENIED,
    );
    expect((await hr.client.rpc("revoke_membership_invite", args)).error?.code).toBe(
      PERMISSION_DENIED,
    );
    expect((await owner.client.rpc("revoke_membership_invite", args)).error).toBeNull();
    expect((await owner.client.rpc("revoke_membership_invite", args)).error?.code).toBe(CANCELLED);

    const { data } = await admin
      .from("membership_invites")
      .select("revoked_at, revoked_by")
      .eq("id", inviteId)
      .single();
    expect(data?.revoked_at).not.toBeNull();
    expect(data?.revoked_by).toBe(owner.id);
  });

  it("the invite page lookup is for the server only", async () => {
    for (const client of [anonClient(), owner.client]) {
      const { error } = await client.rpc("membership_invite_lookup", { p_token: "ab".repeat(32) });
      expect(error).not.toBeNull();
    }
    const invitee = await createTestUser("t-lookup");
    const { data: token } = await owner.client.rpc("create_membership_invite", {
      p_organisation_id: owner.orgId,
      p_email: invitee.email,
      p_role: "hr",
    });
    const { data } = await admin.rpc("membership_invite_lookup", { p_token: token! });
    expect(data?.[0]).toMatchObject({
      organisation_id: owner.orgId,
      organisation_name: "Team Org",
      email: invitee.email.toLowerCase(),
      role: "hr",
      state: "pending",
    });
  });
});

describe("change_member_role and remove_member", () => {
  it("only the owner grants admin or changes an admin", async () => {
    const financeId = await membershipId(finance.id, owner.orgId);
    const promote = await orgAdmin.client.rpc("change_member_role", {
      p_organisation_id: owner.orgId,
      p_membership_id: financeId,
      p_role: "admin",
    });
    expect(promote.error?.code).toBe(PERMISSION_DENIED);
    expect(await roleOf(finance.id, owner.orgId)).toBe("finance");

    const coAdmin = await createTestUser("t-coadmin");
    await join(owner, coAdmin, "admin");
    const demote = await orgAdmin.client.rpc("change_member_role", {
      p_organisation_id: owner.orgId,
      p_membership_id: await membershipId(coAdmin.id, owner.orgId),
      p_role: "hr",
    });
    expect(demote.error?.code).toBe(PERMISSION_DENIED);
    const remove = await orgAdmin.client.rpc("remove_member", {
      p_organisation_id: owner.orgId,
      p_membership_id: await membershipId(coAdmin.id, owner.orgId),
    });
    expect(remove.error?.code).toBe(PERMISSION_DENIED);
    expect(await roleOf(coAdmin.id, owner.orgId)).toBe("admin");

    const byOwner = await owner.client.rpc("change_member_role", {
      p_organisation_id: owner.orgId,
      p_membership_id: await membershipId(coAdmin.id, owner.orgId),
      p_role: "ops_manager",
    });
    expect(byOwner.error).toBeNull();
    expect(await roleOf(coAdmin.id, owner.orgId)).toBe("ops_manager");
  });

  it("nobody changes their own role, and workers are left to People", async () => {
    const own = await orgAdmin.client.rpc("change_member_role", {
      p_organisation_id: owner.orgId,
      p_membership_id: await membershipId(orgAdmin.id, owner.orgId),
      p_role: "hr",
    });
    expect(own.error?.code).toBe(OWN_MEMBERSHIP);
    const workerChange = await owner.client.rpc("change_member_role", {
      p_organisation_id: owner.orgId,
      p_membership_id: await membershipId(worker.id, owner.orgId),
      p_role: "hr",
    });
    expect(workerChange.error?.code).toBe(NOT_A_MANAGER);
    const workerRemove = await owner.client.rpc("remove_member", {
      p_organisation_id: owner.orgId,
      p_membership_id: await membershipId(worker.id, owner.orgId),
    });
    expect(workerRemove.error?.code).toBe(NOT_A_MANAGER);
  });

  it("a role change is audited with who, before and after", async () => {
    const hrId = await membershipId(hr.id, owner.orgId);
    const { data, error } = await orgAdmin.client.rpc("change_member_role", {
      p_organisation_id: owner.orgId,
      p_membership_id: hrId,
      p_role: "line_manager",
    });
    expect(error).toBeNull();
    expect(data?.[0]).toMatchObject({
      member_user_id: hr.id,
      member_email: hr.email.toLowerCase(),
      member_name: "Hauwa Bello",
      old_role: "hr",
      new_role: "line_manager",
    });
    const { data: audit } = await admin
      .from("audit_log")
      .select("actor_id, before, after")
      .eq("action", "memberships.update")
      .eq("entity_id", hrId);
    expect(audit).toHaveLength(1);
    expect(audit?.[0]?.actor_id).toBe(orgAdmin.id);
    expect(audit?.[0]?.before).toMatchObject({ role: "hr" });
    expect(audit?.[0]?.after).toMatchObject({ role: "line_manager" });

    const same = await orgAdmin.client.rpc("change_member_role", {
      p_organisation_id: owner.orgId,
      p_membership_id: hrId,
      p_role: "line_manager",
    });
    expect(same.error?.code).toBe(INVALID);
  });

  it("removing a manager deletes the membership, audited", async () => {
    const leaver = await createTestUser("t-leaver", "Lola Leaver");
    await join(owner, leaver, "hr");
    const id = await membershipId(leaver.id, owner.orgId);
    const { data, error } = await orgAdmin.client.rpc("remove_member", {
      p_organisation_id: owner.orgId,
      p_membership_id: id,
    });
    expect(error).toBeNull();
    expect(data?.[0]).toMatchObject({ member_email: leaver.email.toLowerCase(), old_role: "hr" });
    expect(await roleOf(leaver.id, owner.orgId)).toBeNull();
    const { data: audit } = await admin
      .from("audit_log")
      .select("actor_id, before")
      .eq("action", "memberships.delete")
      .eq("entity_id", id);
    expect(audit).toHaveLength(1);
    expect(audit?.[0]?.actor_id).toBe(orgAdmin.id);
    expect(audit?.[0]?.before).toMatchObject({ role: "hr", user_id: leaver.id });

    // The removed manager no longer sees the company's people.
    const after = await leaver.client
      .from("memberships")
      .select("id")
      .eq("organisation_id", owner.orgId);
    expect(after.data).toEqual([]);
  });
});

describe("another company", () => {
  it("can't list, change, remove, resend or cancel anything here, even with the ids", async () => {
    const financeId = await membershipId(finance.id, owner.orgId);
    const invitee = await createTestUser("t-cross");
    await owner.client.rpc("create_membership_invite", {
      p_organisation_id: owner.orgId,
      p_email: invitee.email,
      p_role: "hr",
    });
    const inviteId = await pendingInviteId(owner.orgId, invitee.email);

    // Aimed at this company: refused for not being its owner or admin.
    const change = await other.client.rpc("change_member_role", {
      p_organisation_id: owner.orgId,
      p_membership_id: financeId,
      p_role: "hr",
    });
    expect(change.error?.code).toBe(PERMISSION_DENIED);
    const remove = await other.client.rpc("remove_member", {
      p_organisation_id: owner.orgId,
      p_membership_id: financeId,
    });
    expect(remove.error?.code).toBe(PERMISSION_DENIED);
    const resend = await other.client.rpc("resend_membership_invite", {
      p_organisation_id: owner.orgId,
      p_invite_id: inviteId,
    });
    expect(resend.error?.code).toBe(PERMISSION_DENIED);

    // Aimed at their own company with this company's ids: not found there.
    const ownOrgChange = await other.client.rpc("change_member_role", {
      p_organisation_id: other.orgId,
      p_membership_id: financeId,
      p_role: "hr",
    });
    expect(ownOrgChange.error?.code).toBe(NOT_FOUND);
    const ownOrgRevoke = await other.client.rpc("revoke_membership_invite", {
      p_organisation_id: other.orgId,
      p_invite_id: inviteId,
    });
    expect(ownOrgRevoke.error?.code).toBe(NOT_FOUND);

    expect(await roleOf(finance.id, owner.orgId)).toBe("finance");
    const { data } = await admin
      .from("membership_invites")
      .select("revoked_at")
      .eq("id", inviteId)
      .single();
    expect(data?.revoked_at).toBeNull();
  });
});

async function sha256(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
}
