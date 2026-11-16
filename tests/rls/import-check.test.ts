/**
 * Slice 1.8: the server's check step (checkImportSpec) against the real database and Storage.
 * The upload, which holds personal data in clear, is removed however the check ends: finished,
 * failed part way (the batch stays `uploaded` and says so), or checked earlier with the
 * removal left undone. A first check that stopped part way is checked again from the file and
 * stores every row under the ids it already had.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { checkImportSpec } from "@/server/people/imports/batches";

import {
  adminClient,
  createTenantUser,
  createTestUser,
  pgClient,
  type Client,
  type TenantUser,
  type TestUser,
} from "./helpers/supabase";

const FILE = readFileSync(
  fileURLToPath(new URL("../../fixtures/people-import-162.csv", import.meta.url)),
);

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let hr: TestUser;

beforeAll(async () => {
  // A throwaway key: the check encrypts each row's personal data.
  vi.stubEnv("PII_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("chk-owner", "Import Check Org");
  hr = await createTestUser("chk-hr");
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: owner.orgId, user_id: hr.id, role: "hr" });
  expect(error).toBeNull();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await db?.end();
});

/** A batch hr created, with the 162-row file uploaded to it. */
async function uploadedBatch() {
  const id = randomUUID();
  const path = `${owner.orgId}/${id}.csv`;
  const insert = await hr.client.from("import_batches").insert({
    id,
    organisation_id: owner.orgId,
    file_name: "people-import-162.csv",
    file_format: "csv",
    file_path: path,
  });
  expect(insert.error).toBeNull();
  const upload = await hr.client.storage
    .from("imports")
    .upload(path, new Blob([FILE], { type: "text/csv" }), { contentType: "text/csv" });
  expect(upload.error).toBeNull();
  return { id, path };
}

function check(batchId: string, supabase: Client = hr.client) {
  return checkImportSpec.run({
    supabase,
    userId: hr.id,
    organisationId: owner.orgId,
    role: "hr",
    data: { batchId },
  });
}

async function state(id: string) {
  const { rows } = await db.query<{
    status: string;
    rows_total: number;
    file_removed_at: Date | null;
    file_problems: { code: string }[];
  }>(
    "select status, rows_total, file_removed_at, file_problems from public.import_batches where id = $1",
    [id],
  );
  return rows[0];
}

async function stored(path: string) {
  const { data } = await admin.storage.from("imports").download(path);
  return data !== null;
}

/** hr's client, with save_import_check failing from its `failFrom`-th call on. */
function failingSaves(failFrom: number): Client {
  let calls = 0;
  return new Proxy(hr.client, {
    get(target, key, receiver) {
      if (key === "rpc") {
        return (fn: string, args: unknown) => {
          if (fn === "save_import_check") {
            calls += 1;
            if (calls >= failFrom) {
              return Promise.resolve({
                data: null,
                error: { code: "57014", message: "canceling statement due to statement timeout" },
              });
            }
          }
          return (target.rpc as (f: string, a: unknown) => unknown)(fn, args);
        };
      }
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === "function" ? (value as () => unknown).bind(target) : value;
    },
  }) as Client;
}

describe("the check step", () => {
  it("stores every row, validates the batch and removes the upload", async () => {
    const batch = await uploadedBatch();
    expect(await check(batch.id)).toEqual({ ok: true, batchId: batch.id });
    const after = await state(batch.id);
    expect(after).toMatchObject({ status: "validated", rows_total: 162 });
    expect(after?.file_removed_at).not.toBeNull();
    expect(await stored(batch.path)).toBe(false);
  });

  it("removes the upload and says so when the check fails part way", async () => {
    const batch = await uploadedBatch();
    await expect(check(batch.id, failingSaves(1))).rejects.toThrow();
    const after = await state(batch.id);
    expect(after).toMatchObject({ status: "uploaded" });
    expect(after?.file_problems.map((p) => p.code)).toEqual(["check_unfinished"]);
    expect(after?.file_removed_at).not.toBeNull();
    expect(await stored(batch.path)).toBe(false);

    // Checking again asks for the file again; nothing is reviewed or imported from it.
    const again = await check(batch.id);
    expect(again).toMatchObject({ ok: false, batchId: batch.id });
  });

  it("removes an upload a finished check left behind", async () => {
    const batch = await uploadedBatch();
    // The rows were stored and the batch validated, but the removal never happened.
    const saved = await hr.client.rpc("save_import_check", {
      p_organisation_id: owner.orgId,
      p_batch_id: batch.id,
      p_check: { columns: ["first_name"], file_notes: [], rows_expected: 1 },
      p_rows: [{ id: randomUUID(), row_number: 2, raw: { first_name: "Ada" }, status: "ready" }],
      p_final: true,
    });
    expect(saved.error).toBeNull();
    expect(await stored(batch.path)).toBe(true);

    expect(await check(batch.id)).toEqual({ ok: true, batchId: batch.id });
    expect((await state(batch.id))?.file_removed_at).not.toBeNull();
    expect(await stored(batch.path)).toBe(false);
  });

  it("checks a batch that stopped part way again from the file, keeping its row ids", async () => {
    const batch = await uploadedBatch();
    // A first chunk was stored, then the server stopped (no removal, no problem recorded).
    const firstId = randomUUID();
    const partial = await hr.client.rpc("save_import_check", {
      p_organisation_id: owner.orgId,
      p_batch_id: batch.id,
      p_check: { columns: ["first_name"], file_notes: [], rows_expected: 162 },
      p_rows: [{ id: firstId, row_number: 2, raw: { first_name: "Partial" }, status: "held" }],
      p_final: false,
    });
    expect(partial.error).toBeNull();
    expect(await state(batch.id)).toMatchObject({ status: "uploaded", rows_total: 1 });

    expect(await check(batch.id)).toEqual({ ok: true, batchId: batch.id });
    expect(await state(batch.id)).toMatchObject({ status: "validated", rows_total: 162 });
    const { rows } = await db.query<{ id: string; raw: { first_name?: string } }>(
      "select id, raw from public.import_rows where batch_id = $1 and row_number = 2",
      [batch.id],
    );
    expect(rows[0]?.id).toBe(firstId);
    expect(rows[0]?.raw.first_name).not.toBe("Partial");
    expect(await stored(batch.path)).toBe(false);
  });
});
