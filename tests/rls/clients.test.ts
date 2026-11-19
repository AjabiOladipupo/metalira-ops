/**
 * Slice 2.1: clients and contacts, and the audit channel.
 * - owner, admin and ops_manager write clients; hr inserts only (the people import); finance and
 *   line_manager read. Nobody deletes a client, site or project.
 * - client_contacts: owner, admin, finance and ops_manager read and write; one primary per client
 *   and role, kept by the database; removed, never deleted.
 * - create_client saves a client, its billing contact and a site whole, as the caller.
 * - audit_log.channel: web by default, worker_app or import from the app's header, system for
 *   the secret key and jobs; never system or lira from a signed-in user's header.
 */
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/types/db";

import {
  adminClient,
  createTenantUser,
  createTestUser,
  loadLocalEnv,
  pgClient,
  type Client,
  type TenantUser,
  type TestUser,
} from "./helpers/supabase";

const PERMISSION_DENIED = "42501";

let admin: Client;
let owner: TenantUser;
let other: TenantUser;
let ops: TestUser;
let hr: TestUser;
let finance: TestUser;
let lineManager: TestUser;
let clientId: string;

async function addMember(user: TestUser, role: "ops_manager" | "hr" | "finance" | "line_manager") {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: owner.orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

/** The user's own session with the app's audit channel header, as the server clients send it. */
async function withChannel(user: TestUser, channel: string): Promise<Client> {
  const { data } = await user.client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("no session");
  const { apiUrl, publishableKey } = loadLocalEnv();
  return createClient<Database>(apiUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}`, "x-metalira-channel": channel } },
  });
}

async function lastAudit(entityId: string, action: string) {
  const { data, error } = await admin
    .from("audit_log")
    .select("action, actor_id, channel")
    .eq("entity_id", entityId)
    .eq("action", action)
    .order("at", { ascending: false })
    .limit(1)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

beforeAll(async () => {
  admin = adminClient();
  owner = await createTenantUser("c-owner", "Clients Org");
  other = await createTenantUser("c-other", "Other Clients Org");
  ops = await createTestUser("c-ops", "Tunde Ops");
  hr = await createTestUser("c-hr", "Hauwa HR");
  finance = await createTestUser("c-finance", "Femi Finance");
  lineManager = await createTestUser("c-lm", "Lara Line");
  await addMember(ops, "ops_manager");
  await addMember(hr, "hr");
  await addMember(finance, "finance");
  await addMember(lineManager, "line_manager");

  const { data, error } = await ops.client.rpc("create_client", {
    p_organisation_id: owner.orgId,
    p_name: "Coastline Logistics",
    p_legal_name: "Coastline Logistics Nigeria Ltd",
    p_rc_number: "RC 1234567",
    p_billing_address: "4 Wharf Road\nApapa",
    p_state: "Lagos",
    p_billing_terms_days: 30,
    p_contact_name: "Ngozi Eze",
    p_contact_email: "  Accounts@Coastline.example ",
    p_site_name: "Apapa Warehouse 3",
  });
  expect(error).toBeNull();
  clientId = data!;
});

describe("create_client", () => {
  it("saves the client, its primary billing contact and a first site, audited", async () => {
    const contacts = await admin.from("client_contacts").select("*").eq("client_id", clientId);
    expect(contacts.data).toEqual([
      expect.objectContaining({
        name: "Ngozi Eze",
        email: "accounts@coastline.example",
        role: "billing",
        is_primary: true,
        status: "active",
      }),
    ]);
    const sites = await admin.from("sites").select("name").eq("client_id", clientId);
    expect(sites.data).toEqual([{ name: "Apapa Warehouse 3" }]);
    const audit = await lastAudit(clientId, "clients.insert");
    expect(audit.actor_id).toBe(ops.id);
  });

  it("saves nothing when one part is refused", async () => {
    const { error } = await finance.client.rpc("create_client", {
      p_organisation_id: owner.orgId,
      p_name: "Finance Made Ltd",
      p_contact_email: "a@b.example",
    });
    expect(error?.code).toBe(PERMISSION_DENIED);
    const bad = await ops.client.rpc("create_client", {
      p_organisation_id: owner.orgId,
      p_name: "Half Saved Ltd",
      p_contact_email: "not an email",
    });
    expect(bad.error).not.toBeNull();
    const rows = await admin
      .from("clients")
      .select("id")
      .eq("organisation_id", owner.orgId)
      .in("name", ["Finance Made Ltd", "Half Saved Ltd"]);
    expect(rows.data).toEqual([]);
  });

  it("can't add a client to another company", async () => {
    const { error } = await other.client.rpc("create_client", {
      p_organisation_id: owner.orgId,
      p_name: "Hijack Ltd",
    });
    expect(error?.code).toBe(PERMISSION_DENIED);
  });
});

describe("clients roles", () => {
  it("lets hr insert a client but not update one", async () => {
    const inserted = await hr.client
      .from("clients")
      .insert({ organisation_id: owner.orgId, name: "Import Made Ltd" })
      .select("id")
      .single();
    expect(inserted.error).toBeNull();
    const updated = await hr.client
      .from("clients")
      .update({ name: "Renamed by HR" })
      .eq("id", inserted.data!.id)
      .select("id");
    expect(updated.data ?? []).toEqual([]);
    const row = await admin.from("clients").select("name").eq("id", inserted.data!.id).single();
    expect(row.data?.name).toBe("Import Made Ltd");
  });

  it("lets ops_manager update and archive, and finance and line_manager only read", async () => {
    const byOps = await ops.client
      .from("clients")
      .update({ tin: "12345678-0001", status: "archived" })
      .eq("id", clientId)
      .select("status");
    expect(byOps.data).toEqual([{ status: "archived" }]);
    const saved = await admin.from("clients").select("tin").eq("id", clientId).single();
    expect(saved.data?.tin).toBe("12345678-0001");
    await ops.client.from("clients").update({ status: "active" }).eq("id", clientId);

    for (const reader of [finance, lineManager]) {
      const read = await reader.client.from("clients").select("id").eq("id", clientId);
      expect(read.data).toEqual([{ id: clientId }]);
      const write = await reader.client
        .from("clients")
        .update({ name: "Nope" })
        .eq("id", clientId)
        .select("id");
      expect(write.data ?? []).toEqual([]);
    }
    const audit = await lastAudit(clientId, "clients.update");
    expect(audit.actor_id).toBe(ops.id);
  });

  it("lets hr add a name only, never billing details", async () => {
    const { error } = await hr.client
      .from("clients")
      .insert({ organisation_id: owner.orgId, name: "Import With TIN Ltd", tin: "1234567890" });
    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  it("shows billing details and notes only to owner, admin, finance and ops_manager", async () => {
    await ops.client.from("clients").update({ notes: "Pays late" }).eq("id", clientId);
    for (const user of [hr, lineManager]) {
      const direct = await user.client.from("clients").select("tin, notes").eq("id", clientId);
      expect(direct.error?.code).toBe(PERMISSION_DENIED);
      const viaRpc = await user.client.rpc("client_billing", { p_organisation_id: owner.orgId });
      expect(viaRpc.data ?? []).toEqual([]);
      // The row itself (name, status) stays readable, as in 1.3.
      const row = await user.client.from("clients").select("name").eq("id", clientId);
      expect(row.data).toEqual([{ name: "Coastline Logistics" }]);
    }
    const forFinance = await finance.client.rpc("client_billing", {
      p_organisation_id: owner.orgId,
      p_client_id: clientId,
    });
    expect(forFinance.data).toEqual([
      expect.objectContaining({ client_id: clientId, notes: "Pays late", state: "Lagos" }),
    ]);
    const otherOrg = await other.client.rpc("client_billing", { p_organisation_id: owner.orgId });
    expect(otherOrg.data ?? []).toEqual([]);
  });

  it("refuses bad billing details in the database", async () => {
    for (const patch of [
      { tin: "123" },
      { billing_terms_days: 400 },
      { status: "deleted" },
      { legal_name: "see www.example.com" },
    ]) {
      const { error } = await ops.client.from("clients").update(patch).eq("id", clientId);
      expect(error?.code, JSON.stringify(patch)).toBe("23514");
    }
  });

  it("deletes no client, site or project, for any role", async () => {
    for (const table of ["clients", "sites", "projects"] as const) {
      const { error } = await owner.client.from(table).delete().eq("organisation_id", owner.orgId);
      expect(error?.code, table).toBe(PERMISSION_DENIED);
    }
    const still = await admin.from("clients").select("id").eq("id", clientId);
    expect(still.data).toHaveLength(1);
  });
});

describe("client_contacts", () => {
  it("is hidden from hr and line managers", async () => {
    for (const user of [hr, lineManager]) {
      const read = await user.client.from("client_contacts").select("id").eq("client_id", clientId);
      expect(read.data ?? []).toEqual([]);
      const insert = await user.client.from("client_contacts").insert({
        organisation_id: owner.orgId,
        client_id: clientId,
        name: "Nope",
        email: "nope@example.test",
        role: "ops",
      });
      expect(insert.error?.code).toBe(PERMISSION_DENIED);
    }
  });

  it("keeps one primary per role: a new primary demotes the old, removal promotes the next", async () => {
    const add = await finance.client
      .from("client_contacts")
      .insert({
        organisation_id: owner.orgId,
        client_id: clientId,
        name: "Bayo Accounts",
        email: "bayo@coastline.example",
        role: "billing",
        is_primary: true,
      })
      .select("id")
      .single();
    expect(add.error).toBeNull();

    const primaries = async () =>
      (
        await admin
          .from("client_contacts")
          .select("name")
          .eq("client_id", clientId)
          .eq("role", "billing")
          .eq("is_primary", true)
      ).data;
    expect(await primaries()).toEqual([{ name: "Bayo Accounts" }]);

    // The first ops contact becomes primary on its own.
    const opsContact = await ops.client
      .from("client_contacts")
      .insert({
        organisation_id: owner.orgId,
        client_id: clientId,
        name: "Chika Site",
        email: "chika@coastline.example",
        role: "ops",
      })
      .select("is_primary")
      .single();
    expect(opsContact.data?.is_primary).toBe(true);

    const removed = await ops.client
      .from("client_contacts")
      .update({ status: "removed" })
      .eq("id", add.data!.id)
      .select("status, is_primary");
    expect(removed.data).toEqual([{ status: "removed", is_primary: false }]);
    expect(await primaries()).toEqual([{ name: "Ngozi Eze" }]);

    // A primary can't simply be unticked: the role would have none.
    const untick = await ops.client
      .from("client_contacts")
      .update({ is_primary: false })
      .eq("client_id", clientId)
      .eq("name", "Ngozi Eze");
    expect(untick.error?.code).toBe("MLCC4");

    // A removed contact can't be changed back.
    const revive = await ops.client
      .from("client_contacts")
      .update({ status: "active" })
      .eq("id", add.data!.id);
    expect(revive.error?.code).toBe("MLCC3");
  });

  it("can't move a contact or change its role, and is never deleted", async () => {
    const { data: contact } = await admin
      .from("client_contacts")
      .select("id")
      .eq("client_id", clientId)
      .eq("name", "Ngozi Eze")
      .single();
    const role = await ops.client
      .from("client_contacts")
      .update({ role: "ops" } as never)
      .eq("id", contact!.id);
    expect(role.error?.code).toBe(PERMISSION_DENIED);
    const del = await owner.client.from("client_contacts").delete().eq("id", contact!.id);
    expect(del.error?.code).toBe(PERMISSION_DENIED);
  });

  it("lower-cases emails and refuses a duplicate active address for the same role", async () => {
    const dup = await ops.client.from("client_contacts").insert({
      organisation_id: owner.orgId,
      client_id: clientId,
      name: "Ngozi Again",
      email: "ACCOUNTS@coastline.example",
      role: "billing",
    });
    expect(dup.error?.code).toBe("23505");
  });
});

describe("audit_log.channel", () => {
  it("is web for a plain signed-in write", async () => {
    const { data } = await ops.client
      .from("clients")
      .insert({ organisation_id: owner.orgId, name: "Web Channel Ltd" })
      .select("id")
      .single();
    expect((await lastAudit(data!.id, "clients.insert")).channel).toBe("web");
  });

  it("takes worker_app and import from the app's header", async () => {
    for (const channel of ["worker_app", "import"]) {
      const client = await withChannel(ops, channel);
      const { data, error } = await client
        .from("clients")
        .insert({ organisation_id: owner.orgId, name: `Channel ${channel} Ltd` })
        .select("id")
        .single();
      expect(error).toBeNull();
      expect((await lastAudit(data!.id, "clients.insert")).channel).toBe(channel);
    }
  });

  it("never takes system or lira from a signed-in user's header", async () => {
    for (const channel of ["system", "lira", "anything"]) {
      const client = await withChannel(ops, channel);
      const { data } = await client
        .from("clients")
        .insert({ organisation_id: owner.orgId, name: `Forged ${channel} Ltd` })
        .select("id")
        .single();
      expect((await lastAudit(data!.id, "clients.insert")).channel).toBe("web");
    }
  });

  it("is system for the secret key and for jobs with no request", async () => {
    const { data } = await admin
      .from("clients")
      .insert({ organisation_id: owner.orgId, name: "Secret Key Ltd" })
      .select("id")
      .single();
    expect((await lastAudit(data!.id, "clients.insert")).channel).toBe("system");

    const db = await pgClient();
    try {
      const inserted = await db.query<{ id: string }>(
        "insert into public.clients (organisation_id, name) values ($1, 'Cron Ltd') returning id",
        [owner.orgId],
      );
      expect((await lastAudit(inserted.rows[0]!.id, "clients.insert")).channel).toBe("system");
    } finally {
      await db.end();
    }
  });

  it("can't be chosen by the insert itself, and stays append-only", async () => {
    const db = await pgClient();
    try {
      const row = await db.query<{ channel: string; id: string }>(
        "insert into public.audit_log (organisation_id, action, entity, channel) values ($1, 'test.event', 'test', 'lira') returning id, channel",
        [owner.orgId],
      );
      expect(row.rows[0]!.channel).toBe("system");
      await expect(
        db.query("update public.audit_log set channel = 'web' where id = $1", [row.rows[0]!.id]),
      ).rejects.toThrow();
    } finally {
      await db.end();
    }
  });
});
