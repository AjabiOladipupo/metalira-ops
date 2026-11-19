/**
 * Owner decision, 19 Nov 2026 (with slice 2.3): only owners give, change or take away the admin,
 * finance and HR roles, because those roles approve bank account and bank-detail changes. Admins
 * still invite and change operations managers and line managers. An invite an admin created for
 * one of those roles before the rule can't be accepted.
 */
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

let admin: Client;
let owner: TenantUser;
let orgAdmin: TestUser;

async function membershipId(userId: string): Promise<string> {
  const { data, error } = await admin
    .from("memberships")
    .select("id")
    .eq("user_id", userId)
    .eq("organisation_id", owner.orgId)
    .single();
  if (error) throw new Error(error.message);
  return data.id;
}

async function roleOf(userId: string) {
  const { data } = await admin
    .from("memberships")
    .select("role")
    .eq("user_id", userId)
    .eq("organisation_id", owner.orgId)
    .maybeSingle();
  return data?.role ?? null;
}

function invite(by: TestUser, email: string, role: Role) {
  return by.client.rpc("create_membership_invite", {
    p_organisation_id: owner.orgId,
    p_email: email,
    p_role: role,
  });
}

async function joinAs(user: TestUser, role: Role) {
  const { data: token, error } = await invite(owner, user.email, role);
  expect(error).toBeNull();
  expect((await user.client.rpc("accept_membership_invite", { p_token: token! })).error).toBeNull();
}

beforeAll(async () => {
  admin = adminClient();
  owner = await createTenantUser("oor-owner", "Owner Only Roles Ltd");
  orgAdmin = await createTestUser("oor-admin", "Ada Admin");
  await joinAs(orgAdmin, "admin");
});

describe("admins can't give admin, finance or HR", () => {
  it("refuses an admin inviting them, and lets the owner", async () => {
    for (const role of ["admin", "finance", "hr"] as const) {
      const invitee = await createTestUser(`oor-inv-${role}`);
      const refused = await invite(orgAdmin, invitee.email, role);
      expect(refused.error?.code).toBe(PERMISSION_DENIED);
      const allowed = await invite(owner, invitee.email, role);
      expect(allowed.error).toBeNull();
    }
  });

  it("still lets an admin invite operations managers and line managers", async () => {
    for (const role of ["ops_manager", "line_manager"] as const) {
      const invitee = await createTestUser(`oor-ok-${role}`);
      const { data: token, error } = await invite(orgAdmin, invitee.email, role);
      expect(error).toBeNull();
      expect(
        (await invitee.client.rpc("accept_membership_invite", { p_token: token! })).error,
      ).toBeNull();
      expect(await roleOf(invitee.id)).toBe(role);
    }
  });

  it("refuses an admin resending an owner's finance invite", async () => {
    const invitee = await createTestUser("oor-resend");
    expect((await invite(owner, invitee.email, "finance")).error).toBeNull();
    const { data } = await admin
      .from("membership_invites")
      .select("id")
      .eq("organisation_id", owner.orgId)
      .eq("email", invitee.email.toLowerCase())
      .is("revoked_at", null)
      .single();
    const resent = await orgAdmin.client.rpc("resend_membership_invite", {
      p_organisation_id: owner.orgId,
      p_invite_id: data!.id,
    });
    expect(resent.error?.code).toBe(PERMISSION_DENIED);
  });

  it("refuses an admin changing someone to or from them, and lets the owner", async () => {
    const ops = await createTestUser("oor-ops");
    await joinAs(ops, "ops_manager");
    for (const role of ["finance", "hr", "admin"] as const) {
      const { error } = await orgAdmin.client.rpc("change_member_role", {
        p_organisation_id: owner.orgId,
        p_membership_id: await membershipId(ops.id),
        p_role: role,
      });
      expect(error?.code).toBe(PERMISSION_DENIED);
    }
    expect(await roleOf(ops.id)).toBe("ops_manager");
    // Between operations manager and line manager is still the admin's call.
    expect(
      (
        await orgAdmin.client.rpc("change_member_role", {
          p_organisation_id: owner.orgId,
          p_membership_id: await membershipId(ops.id),
          p_role: "line_manager",
        })
      ).error,
    ).toBeNull();

    const fin = await createTestUser("oor-fin");
    await joinAs(fin, "finance");
    const fromFinance = await orgAdmin.client.rpc("change_member_role", {
      p_organisation_id: owner.orgId,
      p_membership_id: await membershipId(fin.id),
      p_role: "ops_manager",
    });
    expect(fromFinance.error?.code).toBe(PERMISSION_DENIED);
    const removed = await orgAdmin.client.rpc("remove_member", {
      p_organisation_id: owner.orgId,
      p_membership_id: await membershipId(fin.id),
    });
    expect(removed.error?.code).toBe(PERMISSION_DENIED);
    expect(await roleOf(fin.id)).toBe("finance");

    const byOwner = await owner.client.rpc("change_member_role", {
      p_organisation_id: owner.orgId,
      p_membership_id: await membershipId(fin.id),
      p_role: "hr",
    });
    expect(byOwner.error).toBeNull();
    expect(await roleOf(fin.id)).toBe("hr");
  });
});

describe("invites an admin made before the rule", () => {
  let db: Awaited<ReturnType<typeof pgClient>>;
  beforeAll(async () => {
    db = await pgClient();
  });
  afterAll(async () => {
    await db.end();
  });

  it("can't be accepted for finance; an admin's line manager invite still can", async () => {
    // Planted as an admin's invite from before the rule (the token's hash, as the function does).
    async function planted(email: string, role: Role): Promise<string> {
      const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
      await db.query(
        `insert into public.membership_invites (organisation_id, email, role, token_hash, created_by)
         values ($1, $2, $3::public.membership_role, encode(extensions.digest($4, 'sha256'), 'hex'), $5)`,
        [owner.orgId, email.toLowerCase(), role, token, orgAdmin.id],
      );
      return token;
    }
    const finInvitee = await createTestUser("oor-old-fin");
    const finToken = await planted(finInvitee.email, "finance");
    const refused = await finInvitee.client.rpc("accept_membership_invite", { p_token: finToken });
    expect(refused.error?.code).toBe(PERMISSION_DENIED);
    expect(await roleOf(finInvitee.id)).toBeNull();

    const lmInvitee = await createTestUser("oor-old-lm");
    const lmToken = await planted(lmInvitee.email, "line_manager");
    expect(
      (await lmInvitee.client.rpc("accept_membership_invite", { p_token: lmToken })).error,
    ).toBeNull();
    expect(await roleOf(lmInvitee.id)).toBe("line_manager");
  });
});
