/**
 * Membership management inside one organisation: people join only through an
 * email invite they accept themselves (never a direct insert), admins manage
 * every role except owner, only owners manage owner rows, and every
 * organisation keeps at least one owner (last-owner guard), even for the
 * secret-key client.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  adminClient,
  createTenantUser,
  createTestUser,
  type Client,
  type TenantUser,
  type TestUser,
} from "./helpers/supabase";

const LAST_OWNER = /at least one owner/;
const PERMISSION_DENIED = "42501";
const INVALID = "22023";

type Role = "owner" | "admin" | "hr" | "finance" | "ops_manager" | "line_manager" | "worker";

let admin: Client;
let owner: TenantUser;
let orgAdmin: TestUser;
let staff: TestUser;

async function roleOf(userId: string, orgId: string) {
  const { data } = await admin
    .from("memberships")
    .select("role")
    .eq("user_id", userId)
    .eq("organisation_id", orgId)
    .maybeSingle();
  return data?.role ?? null;
}

async function invite(by: TestUser, orgId: string, email: string, role: Role) {
  return by.client.rpc("create_membership_invite", {
    p_organisation_id: orgId,
    p_email: email,
    p_role: role,
  });
}

async function inviteToken(by: TestUser, orgId: string, email: string, role: Role) {
  const { data, error } = await invite(by, orgId, email, role);
  expect(error).toBeNull();
  expect(data).toMatch(/^[0-9a-f]{64}$/);
  return data!;
}

beforeAll(async () => {
  admin = adminClient();
  owner = await createTenantUser("m-owner", "Membership Org");
  orgAdmin = await createTestUser("m-admin");
  staff = await createTestUser("m-staff");
});

describe("memberships", () => {
  it("an owner invites an admin, who accepts", async () => {
    const token = await inviteToken(owner, owner.orgId, orgAdmin.email.toUpperCase(), "admin");

    // Only the hash is stored, and the audit row drops it.
    const { data: invites } = await admin
      .from("membership_invites")
      .select("id, email, token_hash")
      .eq("organisation_id", owner.orgId);
    expect(invites).toHaveLength(1);
    expect(invites?.[0]?.email).toBe(orgAdmin.email.toLowerCase());
    expect(invites?.[0]?.token_hash).not.toBe(token);
    const { data: inviteAudit } = await admin
      .from("audit_log")
      .select("actor_id, after")
      .eq("action", "membership_invites.insert")
      .eq("entity_id", invites![0]!.id);
    expect(inviteAudit).toHaveLength(1);
    expect(inviteAudit?.[0]?.actor_id).toBe(owner.id);
    expect(JSON.stringify(inviteAudit)).not.toMatch(/token_hash/);

    const accept = await orgAdmin.client.rpc("accept_membership_invite", { p_token: token });
    expect(accept.error).toBeNull();
    expect(accept.data).toBe(owner.orgId);
    expect(await roleOf(orgAdmin.id, owner.orgId)).toBe("admin");

    const { data: audit } = await admin
      .from("audit_log")
      .select("actor_id, after")
      .eq("organisation_id", owner.orgId)
      .eq("action", "memberships.insert")
      .contains("after", { user_id: orgAdmin.id });
    expect(audit).toHaveLength(1);
    expect(audit?.[0]?.actor_id).toBe(orgAdmin.id);
    expect(audit?.[0]?.after).toMatchObject({ created_by: owner.id, role: "admin" });
  });

  it("an owner cannot insert a membership for another user directly", async () => {
    const victim = await createTestUser("m-victim");
    const { error } = await owner.client
      .from("memberships")
      .insert({ organisation_id: owner.orgId, user_id: victim.id, role: "admin" });
    expect(error?.code).toBe(PERMISSION_DENIED);
    expect(await roleOf(victim.id, owner.orgId)).toBeNull();
  });

  it("an invite works only for its own confirmed email, once", async () => {
    const outsider = await createTestUser("m-intruder");
    const token = await inviteToken(orgAdmin, owner.orgId, staff.email, "worker");

    const stolen = await outsider.client.rpc("accept_membership_invite", { p_token: token });
    expect(stolen.error?.code).toBe(PERMISSION_DENIED);
    expect(await roleOf(outsider.id, owner.orgId)).toBeNull();

    const forged = await staff.client.rpc("accept_membership_invite", { p_token: "0".repeat(64) });
    expect(forged.error?.code).toBe(INVALID);

    const accept = await staff.client.rpc("accept_membership_invite", { p_token: token });
    expect(accept.error).toBeNull();
    expect(await roleOf(staff.id, owner.orgId)).toBe("worker");

    const again = await staff.client.rpc("accept_membership_invite", { p_token: token });
    expect(again.error?.code).toBe(INVALID);
  });

  it("an expired invite cannot be accepted", async () => {
    const late = await createTestUser("m-late");
    const token = await inviteToken(owner, owner.orgId, late.email, "hr");
    const { error } = await admin
      .from("membership_invites")
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("organisation_id", owner.orgId)
      .eq("email", late.email.toLowerCase());
    expect(error).toBeNull();

    const accept = await late.client.rpc("accept_membership_invite", { p_token: token });
    expect(accept.error?.code).toBe(INVALID);
    expect(await roleOf(late.id, owner.orgId)).toBeNull();
  });

  it("a new invite replaces the pending one for the same email", async () => {
    const twice = await createTestUser("m-twice");
    const first = await inviteToken(owner, owner.orgId, twice.email, "finance");
    const second = await inviteToken(owner, owner.orgId, twice.email, "ops_manager");

    const old = await twice.client.rpc("accept_membership_invite", { p_token: first });
    expect(old.error?.code).toBe(INVALID);
    const accept = await twice.client.rpc("accept_membership_invite", { p_token: second });
    expect(accept.error).toBeNull();
    expect(await roleOf(twice.id, owner.orgId)).toBe("ops_manager");
  });

  it("an invite for an existing member is refused", async () => {
    const { error } = await invite(owner, owner.orgId, staff.email, "hr");
    expect(error?.code).toBe("23505");
  });

  it("an admin changes a member's role", async () => {
    const update = await orgAdmin.client
      .from("memberships")
      .update({ role: "hr" })
      .eq("organisation_id", owner.orgId)
      .eq("user_id", staff.id)
      .select("role");
    expect(update.error).toBeNull();
    expect(update.data).toEqual([{ role: "hr" }]);
  });

  it("an admin cannot invite an owner", async () => {
    const outsider = await createTestUser("m-outsider");
    const { data, error } = await invite(orgAdmin, owner.orgId, outsider.email, "owner");
    expect(error?.code).toBe(PERMISSION_DENIED);
    expect(data).toBeNull();
    const { count } = await admin
      .from("membership_invites")
      .select("id", { count: "exact", head: true })
      .eq("email", outsider.email.toLowerCase());
    expect(count).toBe(0);
  });

  it("members below admin cannot invite anyone", async () => {
    const outsider = await createTestUser("m-hr-invitee");
    const { error } = await invite(staff, owner.orgId, outsider.email, "worker");
    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  it("an owner invite stops working if the inviter is no longer an owner", async () => {
    const second = await createTenantUser("m-owner2", "Second Owner Org");
    const coOwner = await createTestUser("m-coowner");
    const invitee = await createTestUser("m-owner-invitee");
    const coOwnerToken = await inviteToken(second, second.orgId, coOwner.email, "owner");
    expect(
      (await coOwner.client.rpc("accept_membership_invite", { p_token: coOwnerToken })).error,
    ).toBeNull();

    const token = await inviteToken(coOwner, second.orgId, invitee.email, "owner");
    const demote = await second.client
      .from("memberships")
      .update({ role: "admin" })
      .eq("organisation_id", second.orgId)
      .eq("user_id", coOwner.id);
    expect(demote.error).toBeNull();

    const accept = await invitee.client.rpc("accept_membership_invite", { p_token: token });
    expect(accept.error?.code).toBe(PERMISSION_DENIED);
    expect(await roleOf(invitee.id, second.orgId)).toBeNull();
  });

  it("an admin can revoke a pending invite but not an owner invite", async () => {
    const a = await createTestUser("m-revoke-a");
    const b = await createTestUser("m-revoke-b");
    await inviteToken(owner, owner.orgId, a.email, "worker");
    await inviteToken(owner, owner.orgId, b.email, "owner");

    const revokeA = await orgAdmin.client
      .from("membership_invites")
      .delete()
      .eq("organisation_id", owner.orgId)
      .eq("email", a.email.toLowerCase())
      .select("id");
    expect(revokeA.error).toBeNull();
    expect(revokeA.data).toHaveLength(1);

    const revokeB = await orgAdmin.client
      .from("membership_invites")
      .delete()
      .eq("organisation_id", owner.orgId)
      .eq("email", b.email.toLowerCase())
      .select("id");
    expect(revokeB.error).toBeNull();
    expect(revokeB.data).toEqual([]);
  });

  it("an admin cannot promote anyone to owner", async () => {
    const { error } = await orgAdmin.client
      .from("memberships")
      .update({ role: "owner" })
      .eq("organisation_id", owner.orgId)
      .eq("user_id", staff.id);
    expect(error?.code).toBe(PERMISSION_DENIED);
    expect(await roleOf(staff.id, owner.orgId)).toBe("hr");
  });

  it("an admin cannot change or remove an owner", async () => {
    const update = await orgAdmin.client
      .from("memberships")
      .update({ role: "worker" })
      .eq("organisation_id", owner.orgId)
      .eq("user_id", owner.id)
      .select();
    expect(update.error).toBeNull();
    expect(update.data).toEqual([]);

    const del = await orgAdmin.client
      .from("memberships")
      .delete()
      .eq("organisation_id", owner.orgId)
      .eq("user_id", owner.id)
      .select();
    expect(del.error).toBeNull();
    expect(del.data).toEqual([]);
    expect(await roleOf(owner.id, owner.orgId)).toBe("owner");
  });

  it("members cannot move a membership to another organisation or user", async () => {
    const { error } = await owner.client
      .from("memberships")
      .update({ user_id: owner.id })
      .eq("organisation_id", owner.orgId)
      .eq("user_id", staff.id);
    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  it("the last owner cannot demote or remove themselves", async () => {
    const demote = await owner.client
      .from("memberships")
      .update({ role: "admin" })
      .eq("organisation_id", owner.orgId)
      .eq("user_id", owner.id);
    expect(demote.error?.message).toMatch(LAST_OWNER);

    const leave = await owner.client
      .from("memberships")
      .delete()
      .eq("organisation_id", owner.orgId)
      .eq("user_id", owner.id);
    expect(leave.error?.message).toMatch(LAST_OWNER);
    expect(await roleOf(owner.id, owner.orgId)).toBe("owner");
  });

  it("the secret-key client cannot remove the last owner either", async () => {
    const { error } = await admin
      .from("memberships")
      .delete()
      .eq("organisation_id", owner.orgId)
      .eq("user_id", owner.id);
    expect(error?.message).toMatch(LAST_OWNER);
    expect(await roleOf(owner.id, owner.orgId)).toBe("owner");
  });

  it("an owner can hand over to a second owner and then step down", async () => {
    const promote = await owner.client
      .from("memberships")
      .update({ role: "owner" })
      .eq("organisation_id", owner.orgId)
      .eq("user_id", orgAdmin.id)
      .select("role");
    expect(promote.error).toBeNull();
    expect(promote.data).toEqual([{ role: "owner" }]);

    const stepDown = await owner.client
      .from("memberships")
      .update({ role: "admin" })
      .eq("organisation_id", owner.orgId)
      .eq("user_id", owner.id)
      .select("role");
    expect(stepDown.error).toBeNull();
    expect(stepDown.data).toEqual([{ role: "admin" }]);

    // Removing every owner in one statement still trips the guard.
    const both = await admin
      .from("memberships")
      .delete()
      .eq("organisation_id", owner.orgId)
      .eq("role", "owner");
    expect(both.error?.message).toMatch(LAST_OWNER);
    expect(await roleOf(orgAdmin.id, owner.orgId)).toBe("owner");
  });
});
