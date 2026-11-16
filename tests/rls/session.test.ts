/**
 * Slice 0.4 against the local stack with real JWTs: what the session layer reads, the
 * sign-up organisation step and the audited mutation helper.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { resolveActiveOrg } from "@/server/identity/active-org";
import { runMutation } from "@/server/identity/mutate";
import { loadMemberships } from "@/server/identity/session";
import { ensureOrganisationForNewUser } from "@/server/identity/sign-up";

import {
  adminClient,
  anonClient,
  createTenantUser,
  createTestUser,
  type Client,
  type TenantUser,
} from "./helpers/supabase";

let admin: Client;
let alpha: TenantUser;
let beta: TenantUser;

async function addMember(orgId: string, userId: string, role: "line_manager" | "worker" | "hr") {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: userId, role });
  expect(error).toBeNull();
}

beforeAll(async () => {
  admin = adminClient();
  alpha = await createTenantUser("s-alpha", `Alpha Guards ${randomUUID().slice(0, 6)}`);
  beta = await createTenantUser("s-beta", `Beta Clean ${randomUUID().slice(0, 6)}`);
});

describe("loadMemberships", () => {
  it("lists only the signed-in user's own memberships, even for an owner who can read co-members", async () => {
    const colleague = await createTestUser("s-colleague");
    await addMember(alpha.orgId, colleague.id, "hr");

    // RLS lets the owner read every membership in the organisation...
    const { data: visible } = await alpha.client
      .from("memberships")
      .select("user_id")
      .eq("organisation_id", alpha.orgId);
    expect(visible?.map((m) => m.user_id).sort()).toEqual([alpha.id, colleague.id].sort());

    // ...but the session only uses the owner's own rows.
    const mine = await loadMemberships(alpha.client, alpha.id);
    expect(mine).toEqual([
      {
        organisationId: alpha.orgId,
        organisationName: expect.stringMatching(/^Alpha Guards/),
        role: "owner",
      },
    ]);
  });

  it("never returns another organisation's rows, even when asked for another user", async () => {
    const theirs = await loadMemberships(alpha.client, beta.id);
    expect(theirs).toEqual([]);
  });

  it("lists every organisation of a user in two, and the switcher defaults by name", async () => {
    const multi = await createTenantUser("s-multi", `Zulu Facility ${randomUUID().slice(0, 6)}`);
    await addMember(alpha.orgId, multi.id, "line_manager");
    await addMember(beta.orgId, multi.id, "worker");

    const memberships = await loadMemberships(multi.client, multi.id);
    expect(memberships.map((m) => [m.organisationId, m.role]).sort()).toEqual(
      [
        [multi.orgId, "owner"],
        [alpha.orgId, "line_manager"],
        [beta.orgId, "worker"],
      ].sort(),
    );

    // Alpha sorts before Zulu; the worker membership in Beta is never a manager choice.
    expect(resolveActiveOrg(undefined, memberships)?.organisationId).toBe(alpha.orgId);
    expect(resolveActiveOrg(multi.orgId, memberships)?.organisationId).toBe(multi.orgId);
    expect(resolveActiveOrg(beta.orgId, memberships)?.organisationId).toBe(alpha.orgId);
  });
});

describe("ensureOrganisationForNewUser", () => {
  async function newOwner(companyName: unknown) {
    const email = `rls-signup-${randomUUID()}@example.test`;
    const password = `${randomBytes(18).toString("base64url")}a1`;
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: "Ada Okafor", company_name: companyName },
    });
    expect(created.error).toBeNull();
    const client = anonClient();
    const signIn = await client.auth.signInWithPassword({ email, password });
    expect(signIn.error).toBeNull();
    return { client, user: signIn.data.user! };
  }

  it("creates one organisation with the user as owner, audited, and only once", async () => {
    const name = `Gamma Staffing ${randomUUID().slice(0, 6)}`;
    const { client, user } = await newOwner(name);

    const created = await ensureOrganisationForNewUser(client, user);
    expect(created?.organisationName).toBe(name);
    const orgId = created!.organisationId;

    const { data: members } = await admin
      .from("memberships")
      .select("user_id, role")
      .eq("organisation_id", orgId);
    expect(members).toEqual([{ user_id: user.id, role: "owner" }]);

    const { data: audit } = await admin
      .from("audit_log")
      .select("action, actor_id")
      .eq("organisation_id", orgId)
      .order("action");
    expect(audit).toEqual([
      { action: "memberships.insert", actor_id: user.id },
      { action: "organisations.insert", actor_id: user.id },
    ]);

    // The pending name is cleared, and a second call (another sign-in) creates nothing.
    const { data: after } = await client.auth.getUser();
    expect(after.user?.user_metadata.company_name ?? null).toBeNull();
    expect(await ensureOrganisationForNewUser(client, after.user!)).toBeNull();
    expect(await ensureOrganisationForNewUser(client, user)).toBeNull();
    const { count } = await admin
      .from("memberships")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);
    expect(count).toBe(1);
  });

  it("does nothing without a usable company name", async () => {
    for (const value of [undefined, "", "   ", 42]) {
      const { client, user } = await newOwner(value);
      expect(await ensureOrganisationForNewUser(client, user)).toBeNull();
    }
  });

  it("does nothing for an unconfirmed user", async () => {
    const { client, user } = await newOwner("Unconfirmed Ltd");
    expect(
      await ensureOrganisationForNewUser(client, { ...user, email_confirmed_at: undefined }),
    ).toBeNull();
  });
});

describe("runMutation with real RLS", () => {
  const renameSpec = {
    schema: z.object({ name: z.string().trim().min(2) }),
    run: async ({
      supabase,
      organisationId,
      data,
    }: {
      supabase: Client;
      organisationId: string;
      data: { name: string };
    }) => {
      const { data: rows, error } = await supabase
        .from("organisations")
        .update({ name: data.name })
        .eq("id", organisationId)
        .select("id");
      if (error) throw error;
      if (!rows?.length) throw new Error("no row updated");
      return rows[0]!;
    },
  };

  it("an owner's change is audited by the trigger, plus the app-level event", async () => {
    const owner = await createTenantUser("s-rename", "Before Rename Ltd");
    const result = await runMutation(
      { supabase: owner.client, userId: owner.id, organisationId: owner.orgId, role: "owner" },
      {
        ...renameSpec,
        roles: ["owner", "admin"],
        event: ({ result: row }) => ({
          action: "settings.rename_company",
          entity: "organisations",
          entityId: row.id,
          reason: "Trading name changed",
        }),
      },
      { name: "After Rename Ltd" },
    );
    expect(result.id).toBe(owner.orgId);

    const { data: audit } = await admin
      .from("audit_log")
      .select("action, actor_id, before, after, reason")
      .eq("organisation_id", owner.orgId)
      .in("action", ["organisations.update", "settings.rename_company"])
      .order("action");
    expect(audit).toHaveLength(2);
    expect(audit?.[0]).toMatchObject({
      action: "organisations.update",
      actor_id: owner.id,
      before: { name: "Before Rename Ltd" },
      after: { name: "After Rename Ltd" },
    });
    expect(audit?.[1]).toMatchObject({
      action: "settings.rename_company",
      actor_id: owner.id,
      reason: "Trading name changed",
    });
  });

  it("row-level security still refuses a role the helper was wrongly told to allow", async () => {
    const lineManager = await createTestUser("s-line");
    await addMember(alpha.orgId, lineManager.id, "line_manager");
    await expect(
      runMutation(
        {
          supabase: lineManager.client,
          userId: lineManager.id,
          organisationId: alpha.orgId,
          role: "line_manager",
        },
        { ...renameSpec, roles: ["line_manager"] },
        { name: "Hijacked" },
      ),
    ).rejects.toMatchObject({ code: "failed" });

    const { data } = await admin
      .from("organisations")
      .select("name")
      .eq("id", alpha.orgId)
      .single();
    expect(data?.name).toMatch(/^Alpha Guards/);
  });
});
