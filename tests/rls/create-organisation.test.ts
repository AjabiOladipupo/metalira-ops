/**
 * public.create_organisation: atomic organisation + owner membership, default
 * pay settings, audit rows, validation and the auth requirement. Also the
 * profile created by the auth.users trigger.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { adminClient, anonClient, createTestUser, type Client } from "./helpers/supabase";

let admin: Client;

beforeAll(() => {
  admin = adminClient();
});

async function countFor(userId: string) {
  const memberships = await admin
    .from("memberships")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  const organisations = await admin
    .from("organisations")
    .select("id", { count: "exact", head: true })
    .eq("created_by", userId);
  return { memberships: memberships.count, organisations: organisations.count };
}

describe("create_organisation", () => {
  it("creates the organisation, one owner membership and the audit rows", async () => {
    const owner = await createTestUser("owner");
    const { data: orgId, error } = await owner.client.rpc("create_organisation", {
      p_name: "  Acme Guards  ",
    });
    expect(error).toBeNull();
    expect(orgId).toMatch(/^[0-9a-f-]{36}$/);

    const { data: org } = await admin.from("organisations").select("*").eq("id", orgId!).single();
    expect(org).toMatchObject({
      name: "Acme Guards",
      plan: "trial",
      timezone: "Africa/Lagos",
      pay_cycle_start_day: 20,
      pay_day: 25,
      work_days_per_week: 5,
      standard_shift_minutes: 480,
      hourly_rate_divisor_days: 20,
      created_by: owner.id,
    });

    const { data: memberships } = await admin
      .from("memberships")
      .select("user_id, role")
      .eq("organisation_id", orgId!);
    expect(memberships).toEqual([{ user_id: owner.id, role: "owner" }]);

    const { data: audit } = await admin
      .from("audit_log")
      .select("action, entity, actor_id, entity_id")
      .eq("organisation_id", orgId!)
      .order("action");
    expect(audit).toEqual([
      {
        action: "memberships.insert",
        entity: "memberships",
        actor_id: owner.id,
        entity_id: expect.any(String),
      },
      {
        action: "organisations.insert",
        entity: "organisations",
        actor_id: owner.id,
        entity_id: orgId,
      },
    ]);

    // The owner can read their organisation and its audit log through RLS.
    const own = await owner.client.from("organisations").select("id").eq("id", orgId!);
    expect(own.data).toHaveLength(1);
    const ownAudit = await owner.client
      .from("audit_log")
      .select("id")
      .eq("organisation_id", orgId!);
    expect(ownAudit.data).toHaveLength(2);
  });

  it.each([
    ["an empty name", ""],
    ["a blank name", "    "],
    ["a name over 200 characters", "x".repeat(201)],
  ])("rejects %s and leaves nothing behind", async (_label, name) => {
    const owner = await createTestUser("invalid");
    const { data, error } = await owner.client.rpc("create_organisation", { p_name: name });
    expect(data).toBeNull();
    expect(error?.code).toBe("22023");
    expect(await countFor(owner.id)).toEqual({ memberships: 0, organisations: 0 });
  });

  it.each([
    ["angle brackets", "<b>Acme</b> Guards"],
    ["a web address", "Pay at https://evil.example"],
    ["a www address", "Visit www.evil.example"],
    ["a control character", "Acme\u0007 Guards"],
  ])("rejects a name with %s, which would end up in emails", async (_label, name) => {
    const owner = await createTestUser("not-plain");
    const { data, error } = await owner.client.rpc("create_organisation", { p_name: name });
    expect(data).toBeNull();
    expect(error?.code).toBe("22023");
    expect(await countFor(owner.id)).toEqual({ memberships: 0, organisations: 0 });
  });

  it("refuses a rename to a name that is not plain text", async () => {
    const owner = await createTestUser("rename-org");
    const { data: orgId } = await owner.client.rpc("create_organisation", { p_name: "Plain Ltd" });
    const { error } = await owner.client
      .from("organisations")
      .update({ name: "Your invoice is overdue, pay at www.evil.example" })
      .eq("id", orgId!);
    expect(error?.code).toBe("23514");
    const { data } = await admin.from("organisations").select("name").eq("id", orgId!).single();
    expect(data?.name).toBe("Plain Ltd");
  });

  it("accepts exactly 200 characters", async () => {
    const owner = await createTestUser("long");
    const { error } = await owner.client.rpc("create_organisation", { p_name: "y".repeat(200) });
    expect(error).toBeNull();
    expect(await countFor(owner.id)).toEqual({ memberships: 1, organisations: 1 });
  });

  it("rejects anonymous callers", async () => {
    const { data, error } = await anonClient().rpc("create_organisation", { p_name: "Anon Ltd" });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("is not callable by the secret-key client, which has no user", async () => {
    const { data, error } = await admin.rpc("create_organisation", { p_name: "System Ltd" });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });
});

describe("profiles", () => {
  it("are created on sign-up with the full name from metadata", async () => {
    const person = await createTestUser("profile", "  Ada Obi  ");
    const { data } = await person.client
      .from("profiles")
      .select("user_id, full_name")
      .eq("user_id", person.id)
      .single();
    expect(data).toEqual({ user_id: person.id, full_name: "Ada Obi" });
  });

  it("keep no name when the sign-up metadata name is not plain text", async () => {
    for (const name of ["<a href=x>Ada</a>", "Ada, see https://evil.example", "www.evil.example"]) {
      const person = await createTestUser("profile-bad", name);
      const { data } = await admin
        .from("profiles")
        .select("full_name")
        .eq("user_id", person.id)
        .single();
      expect(data).toEqual({ full_name: null });
    }
  });

  it("cannot be renamed to a name that is not plain text", async () => {
    const person = await createTestUser("rename-bad", "Ada Obi");
    const { error } = await person.client
      .from("profiles")
      .update({ full_name: "<script>Ada</script>" })
      .eq("user_id", person.id);
    expect(error?.code).toBe("23514");
  });

  it("can be renamed by their owner only, and only full_name", async () => {
    const person = await createTestUser("rename");
    const { data, error } = await person.client
      .from("profiles")
      .update({ full_name: "Bola Ade" })
      .eq("user_id", person.id)
      .select("full_name");
    expect(error).toBeNull();
    expect(data).toEqual([{ full_name: "Bola Ade" }]);

    const forged = await person.client
      .from("profiles")
      .update({ created_at: "2000-01-01T00:00:00Z" })
      .eq("user_id", person.id);
    expect(forged.error?.code).toBe("42501");
  });
});
