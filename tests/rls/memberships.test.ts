/**
 * Membership management inside one organisation: admins manage every role
 * except owner, only owners manage owner rows, and every organisation keeps at
 * least one owner (last-owner guard), even for the secret-key client.
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

beforeAll(async () => {
  admin = adminClient();
  owner = await createTenantUser("m-owner", "Membership Org");
  orgAdmin = await createTestUser("m-admin");
  staff = await createTestUser("m-staff");
});

describe("memberships", () => {
  it("an owner adds an admin", async () => {
    const { error } = await owner.client
      .from("memberships")
      .insert({ organisation_id: owner.orgId, user_id: orgAdmin.id, role: "admin" });
    expect(error).toBeNull();
    expect(await roleOf(orgAdmin.id, owner.orgId)).toBe("admin");

    const { data: audit } = await admin
      .from("audit_log")
      .select("actor_id, after")
      .eq("organisation_id", owner.orgId)
      .eq("action", "memberships.insert")
      .contains("after", { user_id: orgAdmin.id });
    expect(audit).toHaveLength(1);
    expect(audit?.[0]?.actor_id).toBe(owner.id);
  });

  it("an admin adds a worker and changes their role", async () => {
    const insert = await orgAdmin.client
      .from("memberships")
      .insert({ organisation_id: owner.orgId, user_id: staff.id, role: "worker" });
    expect(insert.error).toBeNull();

    const update = await orgAdmin.client
      .from("memberships")
      .update({ role: "hr" })
      .eq("organisation_id", owner.orgId)
      .eq("user_id", staff.id)
      .select("role");
    expect(update.error).toBeNull();
    expect(update.data).toEqual([{ role: "hr" }]);
  });

  it("an admin cannot create an owner", async () => {
    const outsider = await createTestUser("m-outsider");
    const { error } = await orgAdmin.client
      .from("memberships")
      .insert({ organisation_id: owner.orgId, user_id: outsider.id, role: "owner" });
    expect(error?.code).toBe("42501");
    expect(await roleOf(outsider.id, owner.orgId)).toBeNull();
  });

  it("an admin cannot promote anyone to owner", async () => {
    const { error } = await orgAdmin.client
      .from("memberships")
      .update({ role: "owner" })
      .eq("organisation_id", owner.orgId)
      .eq("user_id", staff.id);
    expect(error?.code).toBe("42501");
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
    expect(error?.code).toBe("42501");
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
