/**
 * Slice 2.6: contract documents, against the real database and Storage.
 * - owner, admin and ops_manager upload; finance reads; hr, line managers and other companies
 *   see nothing, through the table or the bucket.
 * - Storage takes an object only at the path of the uploader's own pending row, never replaces
 *   one, and serves it only while the row is active (the uploader also reads their own pending
 *   upload back). A removed document can't be opened.
 * - The row moves only pending -> active -> removed (or pending -> rejected), through the
 *   functions, and is never deleted or edited, by any role.
 * - The sweep rejects stale uploads and deletes files 30 days after removal.
 * Cross-organisation isolation of the table is also covered by isolation.test.ts
 * (tables/documents.ts).
 */
import { createHash, randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sweepContractDocuments } from "@/server/business/contract-document-sweep";
import type { Json } from "@/types/db";

import {
  adminClient,
  createTenantUser,
  createTestUser,
  pgClient,
  type Client,
  type TenantUser,
  type TestUser,
} from "./helpers/supabase";

const PERMISSION_DENIED = "42501";
const BUCKET = "contract-docs";

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
let ops: TestUser;
let ops2: TestUser;
let finance: TestUser;
let hr: TestUser;
let lineManager: TestUser;
let contractId: string;
let otherContractId: string;

const PDF = Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer\n%%EOF\n");
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function addMember(user: TestUser, role: "ops_manager" | "hr" | "finance" | "line_manager") {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: owner.orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

async function newContract(org: TenantUser, name: string): Promise<string> {
  const client = await org.client.rpc("create_client", {
    p_organisation_id: org.orgId,
    p_name: `${name} client`,
    p_site_name: `${name} site`,
  });
  expect(client.error).toBeNull();
  const { data, error } = await org.client.rpc("create_contract", {
    p_organisation_id: org.orgId,
    p_contract: {
      client_id: client.data!,
      name,
      type: "manned_post",
      start_date: "2026-11-01",
    } as Json,
  });
  expect(error).toBeNull();
  return data!;
}

/** A pending row made by `by` in the owner's company (or `orgId`). */
async function start(
  by: Client = ops.client,
  { orgId = owner.orgId, contract = contractId, kind = "signed_contract" } = {},
) {
  return by
    .from("contract_documents")
    .insert({
      organisation_id: orgId,
      contract_id: contract,
      kind,
      title: "Coastline guarding contract",
      file_name: "contract.pdf",
      file_ext: "pdf",
      mime_type: "application/pdf",
    })
    .select("id, storage_path, status, uploaded_by")
    .single();
}

function upload(by: Client, path: string, body: Buffer = PDF, upsert = false) {
  return by.storage.from(BUCKET).upload(path, body, { contentType: "application/pdf", upsert });
}

function confirm(by: Client, id: string, size = PDF.length, digest = sha(PDF)) {
  return by.rpc("confirm_contract_document", {
    p_organisation_id: owner.orgId,
    p_document_id: id,
    p_size_bytes: size,
    p_sha256: digest,
  });
}

/** A document on file, uploaded by ops. */
async function activeDocument() {
  const row = await start();
  expect(row.error).toBeNull();
  expect((await upload(ops.client, row.data!.storage_path)).error).toBeNull();
  expect((await confirm(ops.client, row.data!.id)).error).toBeNull();
  return row.data!;
}

async function canRead(by: Client, path: string): Promise<boolean> {
  const { data } = await by.storage.from(BUCKET).download(path);
  return data !== null;
}

async function canSign(by: Client, path: string): Promise<boolean> {
  const { data } = await by.storage.from(BUCKET).createSignedUrl(path, 60);
  return Boolean(data?.signedUrl);
}

async function stored(path: string): Promise<boolean> {
  const { data } = await admin.storage.from(BUCKET).download(path);
  return data !== null;
}

async function row(id: string) {
  const { rows } = await db.query<{
    status: string;
    size_bytes: string | null;
    sha256: string | null;
    removed_reason: string | null;
    removed_by: string | null;
    file_deleted_at: Date | null;
  }>(
    "select status, size_bytes::text, sha256, removed_reason, removed_by, file_deleted_at from public.contract_documents where id = $1",
    [id],
  );
  return rows[0];
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("cd-owner", "Documents Org");
  other = await createTenantUser("cd-other", "Other Documents Org");
  ops = await createTestUser("cd-ops", "Tunde Ops");
  ops2 = await createTestUser("cd-ops2", "Bola Ops");
  finance = await createTestUser("cd-fin", "Femi Finance");
  hr = await createTestUser("cd-hr", "Hauwa HR");
  lineManager = await createTestUser("cd-lm", "Lara Line");
  await addMember(ops, "ops_manager");
  await addMember(ops2, "ops_manager");
  await addMember(finance, "finance");
  await addMember(hr, "hr");
  await addMember(lineManager, "line_manager");
  contractId = await newContract(owner, "Coastline guarding");
  otherContractId = await newContract(other, "Rival guarding");
});

afterAll(async () => {
  await db?.end();
});

describe("who uploads", () => {
  it("lets owners and ops managers start an upload at a path the database fixes", async () => {
    for (const by of [owner.client, ops.client]) {
      const { data, error } = await start(by);
      expect(error).toBeNull();
      expect(data?.status).toBe("pending");
      expect(data?.storage_path).toBe(`${owner.orgId}/${contractId}/${data?.id}.pdf`);
    }
  });

  it("takes the uploader from the session and the state from nobody", async () => {
    const id = randomUUID();
    const { data, error } = await ops.client
      .from("contract_documents")
      .insert({
        id,
        organisation_id: owner.orgId,
        contract_id: contractId,
        kind: "sla",
        title: "SLA",
        file_name: "sla.pdf",
        file_ext: "pdf",
        mime_type: "application/pdf",
      })
      .select("uploaded_by, status, storage_path")
      .single();
    expect(error).toBeNull();
    expect(data?.uploaded_by).toBe(ops.id);
    // Columns outside the insert grant are refused outright.
    const forged = await ops.client.from("contract_documents").insert({
      organisation_id: owner.orgId,
      contract_id: contractId,
      kind: "sla",
      title: "SLA",
      file_name: "sla.pdf",
      file_ext: "pdf",
      mime_type: "application/pdf",
      status: "active",
      storage_path: `${other.orgId}/${otherContractId}/${randomUUID()}.pdf`,
    } as never);
    expect(forged.error?.code).toBe(PERMISSION_DENIED);
  });

  it("refuses finance, hr, line managers and another company", async () => {
    for (const by of [finance.client, hr.client, lineManager.client, other.client]) {
      const { error } = await start(by);
      expect(error?.code).toBe(PERMISSION_DENIED);
    }
    // Another company's own contract can't be put under this company either.
    const cross = await start(other.client, { orgId: other.orgId, contract: contractId });
    expect(cross.error).not.toBeNull();
  });

  it("refuses a type outside PDF, PNG and JPEG and a mismatched MIME type", async () => {
    const base = {
      organisation_id: owner.orgId,
      contract_id: contractId,
      kind: "other",
      title: "Notes",
      file_name: "notes.html",
    };
    const html = await ops.client
      .from("contract_documents")
      .insert({ ...base, file_ext: "html", mime_type: "text/html" });
    expect(html.error?.code).toBe("23514");
    const mismatch = await ops.client
      .from("contract_documents")
      .insert({ ...base, file_name: "a.pdf", file_ext: "pdf", mime_type: "image/png" });
    expect(mismatch.error?.code).toBe("23514");
  });
});

describe("the contract-docs bucket", () => {
  it("takes an object only at the path of the uploader's own pending row", async () => {
    const mine = await start();
    expect((await upload(ops.client, mine.data!.storage_path)).error).toBeNull();

    // No row at this path.
    const stray = await upload(ops.client, `${owner.orgId}/${contractId}/${randomUUID()}.pdf`);
    expect(stray.error).not.toBeNull();

    // Another ops manager's pending row.
    const theirs = await start(ops2.client);
    expect((await upload(ops.client, theirs.data!.storage_path)).error).not.toBeNull();

    // Never replaced.
    expect((await upload(ops.client, mine.data!.storage_path, PDF, true)).error).not.toBeNull();
  });

  it("refuses company B under company A's prefix, and hr and finance anywhere", async () => {
    const pending = await start();
    for (const by of [other.client, hr.client, finance.client, lineManager.client]) {
      expect((await upload(by, pending.data!.storage_path)).error).not.toBeNull();
      expect(
        (await upload(by, `${owner.orgId}/${contractId}/${randomUUID()}.pdf`)).error,
      ).not.toBeNull();
    }
    // Company B's own pending row can't point its upload into A's prefix either: the path is
    // fixed by the database from B's own ids.
    const b = await start(other.client, { orgId: other.orgId, contract: otherContractId });
    expect(b.data?.storage_path.startsWith(`${other.orgId}/`)).toBe(true);
    expect((await upload(other.client, b.data!.storage_path)).error).toBeNull();
  });

  it("lets only the uploader read a pending upload", async () => {
    const pending = await start();
    expect((await upload(ops.client, pending.data!.storage_path)).error).toBeNull();
    expect(await canRead(ops.client, pending.data!.storage_path)).toBe(true);
    for (const by of [owner.client, ops2.client, finance.client, hr.client, other.client]) {
      expect(await canRead(by, pending.data!.storage_path)).toBe(false);
    }
  });

  it("serves an active document to owner, finance and ops managers only", async () => {
    const doc = await activeDocument();
    for (const by of [owner.client, ops.client, ops2.client, finance.client]) {
      expect(await canRead(by, doc.storage_path)).toBe(true);
      expect(await canSign(by, doc.storage_path)).toBe(true);
    }
    for (const by of [hr.client, lineManager.client, other.client]) {
      expect(await canRead(by, doc.storage_path)).toBe(false);
      expect(await canSign(by, doc.storage_path)).toBe(false);
      const { data } = await by.from("contract_documents").select("id").eq("id", doc.id);
      expect(data).toEqual([]);
    }
  });

  it("has no update or delete for signed-in users", async () => {
    const doc = await activeDocument();
    const moved = await owner.client.storage
      .from(BUCKET)
      .move(doc.storage_path, `${owner.orgId}/${contractId}/${randomUUID()}.pdf`);
    expect(moved.error).not.toBeNull();
    const removed = await owner.client.storage.from(BUCKET).remove([doc.storage_path]);
    expect(removed.data ?? []).toEqual([]);
    expect(await stored(doc.storage_path)).toBe(true);
  });
});

describe("confirm", () => {
  it("puts a matching upload on file and audits it", async () => {
    const doc = await activeDocument();
    const state = await row(doc.id);
    expect(state).toMatchObject({
      status: "active",
      size_bytes: String(PDF.length),
      sha256: sha(PDF),
    });
    const { data: audit } = await admin
      .from("audit_log")
      .select("actor_id, channel, after")
      .eq("entity_id", doc.id)
      .eq("action", "contract_document.uploaded")
      .single();
    expect(audit?.actor_id).toBe(ops.id);
    expect(audit?.channel).toBe("web");
    expect((audit?.after as { sha256?: string })?.sha256).toBe(sha(PDF));
  });

  it("refuses a size that isn't what Storage holds, a missing upload and someone else's row", async () => {
    const pending = await start();
    expect((await confirm(ops.client, pending.data!.id)).error?.code).toBe("MLCD3");
    expect((await upload(ops.client, pending.data!.storage_path)).error).toBeNull();
    expect((await confirm(ops.client, pending.data!.id, PDF.length + 1)).error?.code).toBe("MLCD3");
    expect((await confirm(ops2.client, pending.data!.id)).error?.code).toBe("MLCD1");
    expect((await confirm(finance.client, pending.data!.id)).error?.code).toBe(PERMISSION_DENIED);
    expect((await confirm(other.client, pending.data!.id)).error?.code).toBe(PERMISSION_DENIED);
    expect((await row(pending.data!.id))?.status).toBe("pending");
    // A rejected upload can't be confirmed later.
    expect(
      (
        await ops.client.rpc("reject_contract_document", {
          p_organisation_id: owner.orgId,
          p_document_id: pending.data!.id,
        })
      ).error,
    ).toBeNull();
    expect((await confirm(ops.client, pending.data!.id)).error?.code).toBe("MLCD2");
    expect(await canRead(ops.client, pending.data!.storage_path)).toBe(false);
  });

  it("refuses an upload once the row is active", async () => {
    const doc = await activeDocument();
    expect((await upload(ops.client, doc.storage_path, PDF, true)).error).not.toBeNull();
  });
});

describe("remove", () => {
  it("needs a reason and an editor", async () => {
    const doc = await activeDocument();
    const blank = await ops.client.rpc("remove_contract_document", {
      p_organisation_id: owner.orgId,
      p_document_id: doc.id,
      p_reason: "  ",
    });
    expect(blank.error?.code).toBe("22023");
    for (const by of [finance.client, hr.client, other.client]) {
      const { error } = await by.rpc("remove_contract_document", {
        p_organisation_id: owner.orgId,
        p_document_id: doc.id,
        p_reason: "Not needed",
      });
      expect(error?.code).toBe(PERMISSION_DENIED);
    }
    expect((await row(doc.id))?.status).toBe("active");
  });

  it("marks it removed with who and why, and the file stops opening for everyone", async () => {
    const doc = await activeDocument();
    const { error } = await ops2.client.rpc("remove_contract_document", {
      p_organisation_id: owner.orgId,
      p_document_id: doc.id,
      p_reason: "Unsigned draft uploaded by mistake",
    });
    expect(error).toBeNull();
    expect(await row(doc.id)).toMatchObject({
      status: "removed",
      removed_by: ops2.id,
      removed_reason: "Unsigned draft uploaded by mistake",
    });
    for (const by of [owner.client, ops.client, ops2.client, finance.client]) {
      expect(await canRead(by, doc.storage_path)).toBe(false);
      expect(await canSign(by, doc.storage_path)).toBe(false);
    }
    // The row stays readable; the file is still kept for the 30 days.
    const { data } = await finance.client
      .from("contract_documents")
      .select("status")
      .eq("id", doc.id)
      .single();
    expect(data?.status).toBe("removed");
    expect(await stored(doc.storage_path)).toBe(true);

    const { data: audit } = await admin
      .from("audit_log")
      .select("actor_id, reason")
      .eq("entity_id", doc.id)
      .eq("action", "contract_document.removed")
      .single();
    expect(audit).toEqual({ actor_id: ops2.id, reason: "Unsigned draft uploaded by mistake" });

    const again = await ops.client.rpc("remove_contract_document", {
      p_organisation_id: owner.orgId,
      p_document_id: doc.id,
      p_reason: "Again",
    });
    expect(again.error?.code).toBe("MLCD2");
  });
});

describe("never edited or deleted", () => {
  it("refuses direct updates and deletes from signed-in users", async () => {
    const doc = await activeDocument();
    const update = await owner.client
      .from("contract_documents")
      .update({ title: "Changed" } as never)
      .eq("id", doc.id);
    expect(update.error?.code).toBe(PERMISSION_DENIED);
    const del = await owner.client.from("contract_documents").delete().eq("id", doc.id);
    expect(del.error?.code).toBe(PERMISSION_DENIED);
  });

  it("refuses the database owner and the secret key too", async () => {
    const doc = await activeDocument();
    await expect(
      db.query("delete from public.contract_documents where id = $1", [doc.id]),
    ).rejects.toMatchObject({ code: "MLCD4" });
    await expect(
      db.query("update public.contract_documents set title = 'Changed' where id = $1", [doc.id]),
    ).rejects.toMatchObject({ code: "MLCD4" });
    await expect(
      db.query("update public.contract_documents set status = 'pending' where id = $1", [doc.id]),
    ).rejects.toMatchObject({ code: "MLCD2" });
    const viaKey = await admin
      .from("contract_documents")
      .update({ sha256: "0".repeat(64) })
      .eq("id", doc.id);
    expect(viaKey.error?.code).toBe("MLCD4");
  });
});

describe("sweep", () => {
  it("rejects stale uploads and deletes files of rejected and long-removed documents", async () => {
    // Started two hours ago and never confirmed.
    const stale = await start();
    expect((await upload(ops.client, stale.data!.storage_path)).error).toBeNull();
    // created_at never changes (the guard): age the row by running the sweep two hours later.
    const later = new Date(Date.now() + 2 * 60 * 60 * 1000);

    // Removed, and the sweep runs 31 days later.
    const old = await activeDocument();
    expect(
      (
        await ops.client.rpc("remove_contract_document", {
          p_organisation_id: owner.orgId,
          p_document_id: old.id,
          p_reason: "Superseded",
        })
      ).error,
    ).toBeNull();
    const kept = await activeDocument();

    const result = await sweepContractDocuments(admin, later);
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect((await row(stale.data!.id))?.status).toBe("rejected");
    expect((await row(stale.data!.id))?.file_deleted_at).not.toBeNull();
    expect(await stored(stale.data!.storage_path)).toBe(false);
    // Removed less than 30 days before: kept.
    expect(await stored(old.storage_path)).toBe(true);

    await sweepContractDocuments(admin, new Date(Date.now() + 31 * 24 * 60 * 60 * 1000));
    expect(await stored(old.storage_path)).toBe(false);
    expect((await row(old.id))?.file_deleted_at).not.toBeNull();
    expect((await row(old.id))?.status).toBe("removed");
    // Active documents are never touched.
    expect(await stored(kept.storage_path)).toBe(true);
    expect((await row(kept.id))?.status).toBe("active");
  });
});
