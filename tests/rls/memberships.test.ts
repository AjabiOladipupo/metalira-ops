/**
 * Membership management inside one organisation: people join only through an
 * email invite they accept themselves (never a direct insert); roles change and
 * members leave only through change_member_role and remove_member (slice 1.12:
 * only the owner grants or changes admin, nobody changes their own role, the
 * owner can't be changed or removed); and every organisation keeps at least one
 * owner (last-owner guard), even for the secret-key client.
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
// Slice 1.12 refusals (supabase/migrations/20261117120000_team_invites.sql).
const ALREADY_MEMBER = "MLTM1";
const USED = "MLTM3";
const EXPIRED = "MLTM4";
const CANCELLED = "MLTM5";
const OWN_MEMBERSHIP = "MLTM6";
const OWNER_PROTECTED = "MLTM7";

type Role =
  | "owner"
  | "admin"
  | "hr"
  | "finance"
  | "ops_manager"
  | "line_manager"
  | "worker"
  | "client_approver";

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
    const token = await inviteToken(orgAdmin, owner.orgId, staff.email, "line_manager");

    const stolen = await outsider.client.rpc("accept_membership_invite", { p_token: token });
    expect(stolen.error?.code).toBe(PERMISSION_DENIED);
    expect(await roleOf(outsider.id, owner.orgId)).toBeNull();

    const forged = await staff.client.rpc("accept_membership_invite", { p_token: "0".repeat(64) });
    expect(forged.error?.code).toBe(INVALID);

    const accept = await staff.client.rpc("accept_membership_invite", { p_token: token });
    expect(accept.error).toBeNull();
    expect(await roleOf(staff.id, owner.orgId)).toBe("line_manager");

    const again = await staff.client.rpc("accept_membership_invite", { p_token: token });
    expect(again.error?.code).toBe(USED);
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
    expect(accept.error?.code).toBe(EXPIRED);
    expect(await roleOf(late.id, owner.orgId)).toBeNull();
  });

  it("a new invite replaces the pending one for the same email", async () => {
    const twice = await createTestUser("m-twice");
    const first = await inviteToken(owner, owner.orgId, twice.email, "finance");
    const second = await inviteToken(owner, owner.orgId, twice.email, "ops_manager");

    const old = await twice.client.rpc("accept_membership_invite", { p_token: first });
    expect(old.error?.code).toBe(CANCELLED);
    const accept = await twice.client.rpc("accept_membership_invite", { p_token: second });
    expect(accept.error).toBeNull();
    expect(await roleOf(twice.id, owner.orgId)).toBe("ops_manager");
  });

  it("an invite for an existing member is refused", async () => {
    const { error } = await invite(owner, owner.orgId, staff.email, "hr");
    expect(error?.code).toBe(ALREADY_MEMBER);
  });

  it("an admin changes a member's role through change_member_role only", async () => {
    const direct = await orgAdmin.client
      .from("memberships")
      .update({ role: "hr" })
      .eq("organisation_id", owner.orgId)
      .eq("user_id", staff.id);
    expect(direct.error?.code).toBe(PERMISSION_DENIED);

    const { data, error } = await orgAdmin.client.rpc("change_member_role", {
      p_organisation_id: owner.orgId,
      p_membership_id: await membershipId(staff.id, owner.orgId),
      p_role: "hr",
    });
    expect(error).toBeNull();
    expect(data?.[0]).toMatchObject({ old_role: "line_manager", new_role: "hr" });
    expect(await roleOf(staff.id, owner.orgId)).toBe("hr");
  });

  it("an admin cannot invite an owner or an admin", async () => {
    const outsider = await createTestUser("m-outsider");
    const asOwner = await invite(orgAdmin, owner.orgId, outsider.email, "owner");
    expect(asOwner.error?.code).toBe(INVALID);
    const asAdmin = await invite(orgAdmin, owner.orgId, outsider.email, "admin");
    expect(asAdmin.error?.code).toBe(PERMISSION_DENIED);
    const { count } = await admin
      .from("membership_invites")
      .select("id", { count: "exact", head: true })
      .eq("email", outsider.email.toLowerCase());
    expect(count).toBe(0);
  });

  it("nobody invites owners, workers or client approvers from the team page", async () => {
    const outsider = await createTestUser("m-worker-invitee");
    for (const role of ["worker", "client_approver", "owner"] as const) {
      const { error } = await invite(owner, owner.orgId, outsider.email, role);
      expect(error?.code).toBe(INVALID);
    }
  });

  it("members below admin cannot invite anyone", async () => {
    const outsider = await createTestUser("m-hr-invitee");
    const { error } = await invite(staff, owner.orgId, outsider.email, "hr");
    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  it("an invite stops working once its inviter leaves the company", async () => {
    const second = await createTenantUser("m-owner2", "Second Owner Org");
    const coAdmin = await createTestUser("m-coadmin");
    const invitee = await createTestUser("m-left-invitee");
    const adminToken = await inviteToken(second, second.orgId, coAdmin.email, "admin");
    expect(
      (await coAdmin.client.rpc("accept_membership_invite", { p_token: adminToken })).error,
    ).toBeNull();

    const token = await inviteToken(coAdmin, second.orgId, invitee.email, "finance");
    const removed = await second.client.rpc("remove_member", {
      p_organisation_id: second.orgId,
      p_membership_id: await membershipId(coAdmin.id, second.orgId),
    });
    expect(removed.error).toBeNull();

    const accept = await invitee.client.rpc("accept_membership_invite", { p_token: token });
    expect(accept.error?.code).toBe(PERMISSION_DENIED);
    expect(await roleOf(invitee.id, second.orgId)).toBeNull();
  });

  it("an admin cancels a pending invite but not an admin invite, and nobody deletes invites", async () => {
    const a = await createTestUser("m-revoke-a");
    const b = await createTestUser("m-revoke-b");
    const tokenA = await inviteToken(owner, owner.orgId, a.email, "hr");
    await inviteToken(owner, owner.orgId, b.email, "admin");
    const idOf = async (email: string) => {
      const { data } = await admin
        .from("membership_invites")
        .select("id")
        .eq("organisation_id", owner.orgId)
        .eq("email", email.toLowerCase())
        .is("revoked_at", null)
        .single();
      return data!.id;
    };

    const del = await orgAdmin.client
      .from("membership_invites")
      .delete()
      .eq("organisation_id", owner.orgId)
      .eq("email", a.email.toLowerCase());
    expect(del.error?.code).toBe(PERMISSION_DENIED);

    const revokeA = await orgAdmin.client.rpc("revoke_membership_invite", {
      p_organisation_id: owner.orgId,
      p_invite_id: await idOf(a.email),
    });
    expect(revokeA.error).toBeNull();
    const accept = await a.client.rpc("accept_membership_invite", { p_token: tokenA });
    expect(accept.error?.code).toBe(CANCELLED);

    const revokeB = await orgAdmin.client.rpc("revoke_membership_invite", {
      p_organisation_id: owner.orgId,
      p_invite_id: await idOf(b.email),
    });
    expect(revokeB.error?.code).toBe(PERMISSION_DENIED);
  });

  it("an admin cannot promote anyone to owner", async () => {
    const direct = await orgAdmin.client
      .from("memberships")
      .update({ role: "owner" })
      .eq("organisation_id", owner.orgId)
      .eq("user_id", staff.id);
    expect(direct.error?.code).toBe(PERMISSION_DENIED);
    const viaRpc = await orgAdmin.client.rpc("change_member_role", {
      p_organisation_id: owner.orgId,
      p_membership_id: await membershipId(staff.id, owner.orgId),
      p_role: "owner",
    });
    expect(viaRpc.error?.code).toBe(INVALID);
    expect(await roleOf(staff.id, owner.orgId)).toBe("hr");
  });

  it("nobody can change or remove the owner", async () => {
    const ownerMembership = await membershipId(owner.id, owner.orgId);
    const update = await orgAdmin.client
      .from("memberships")
      .update({ role: "worker" })
      .eq("id", ownerMembership);
    expect(update.error?.code).toBe(PERMISSION_DENIED);
    const del = await orgAdmin.client.from("memberships").delete().eq("id", ownerMembership);
    expect(del.error?.code).toBe(PERMISSION_DENIED);

    const demote = await orgAdmin.client.rpc("change_member_role", {
      p_organisation_id: owner.orgId,
      p_membership_id: ownerMembership,
      p_role: "hr",
    });
    expect(demote.error?.code).toBe(OWNER_PROTECTED);
    const remove = await orgAdmin.client.rpc("remove_member", {
      p_organisation_id: owner.orgId,
      p_membership_id: ownerMembership,
    });
    expect(remove.error?.code).toBe(OWNER_PROTECTED);
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

  it("the owner cannot demote or remove themselves", async () => {
    const own = await membershipId(owner.id, owner.orgId);
    const demote = await owner.client.rpc("change_member_role", {
      p_organisation_id: owner.orgId,
      p_membership_id: own,
      p_role: "admin",
    });
    expect(demote.error?.code).toBe(OWN_MEMBERSHIP);
    const leave = await owner.client.rpc("remove_member", {
      p_organisation_id: owner.orgId,
      p_membership_id: own,
    });
    expect(leave.error?.code).toBe(OWN_MEMBERSHIP);
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

  it("removing every owner in one statement still trips the guard", async () => {
    const coOwner = await createTestUser("m-co-owner");
    const added = await admin
      .from("memberships")
      .insert({ organisation_id: owner.orgId, user_id: coOwner.id, role: "owner" });
    expect(added.error).toBeNull();

    const both = await admin
      .from("memberships")
      .delete()
      .eq("organisation_id", owner.orgId)
      .eq("role", "owner");
    expect(both.error?.message).toMatch(LAST_OWNER);
    expect(await roleOf(owner.id, owner.orgId)).toBe("owner");
    expect(await roleOf(coOwner.id, owner.orgId)).toBe("owner");
  });
});
