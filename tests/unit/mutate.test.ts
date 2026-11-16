import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { redactForAudit } from "@/server/identity/audit";
import { MutationError, runMutation, type MutationContext } from "@/server/identity/mutate";
import type { Database } from "@/types/db";

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));

const ORG = "a0000000-0000-4000-8000-000000000001";
const ENTITY = "b0000000-0000-4000-8000-000000000002";

function fakeClient(
  rpcResult: { data: unknown; error: unknown } = { data: "audit-id", error: null },
) {
  const rpc = vi.fn().mockResolvedValue(rpcResult);
  return { client: { rpc } as unknown as SupabaseClient<Database>, rpc };
}

function context(role: MutationContext["role"], client: SupabaseClient<Database>): MutationContext {
  return { supabase: client, userId: "user-1", organisationId: ORG, role };
}

const renameSpec = {
  schema: z.object({ name: z.string().trim().min(2, "Enter a name") }),
  roles: ["owner", "admin"] as const,
};

describe("runMutation", () => {
  it("refuses a role outside the allowed list before validating or running", async () => {
    const { client, rpc } = fakeClient();
    const run = vi.fn();
    await expect(
      runMutation(context("line_manager", client), { ...renameSpec, run }, { name: "" }),
    ).rejects.toMatchObject({ name: "MutationError", code: "forbidden" });
    expect(run).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects invalid input with field errors and never runs or audits", async () => {
    const { client, rpc } = fakeClient();
    const run = vi.fn();
    const error = await runMutation(
      context("owner", client),
      { ...renameSpec, run },
      { name: " " },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MutationError);
    expect(error).toMatchObject({ code: "invalid", fieldErrors: { name: "Enter a name" } });
    expect(run).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("runs with parsed data and the caller's organisation, and needs no audit call for row changes", async () => {
    const { client, rpc } = fakeClient();
    const run = vi.fn().mockResolvedValue({ id: ENTITY });
    const result = await runMutation(
      context("admin", client),
      { ...renameSpec, run },
      { name: " Alpha " },
    );
    expect(result).toEqual({ id: ENTITY });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        organisationId: ORG,
        userId: "user-1",
        role: "admin",
        data: { name: "Alpha" },
      }),
    );
    // Row changes are audited by database triggers in the same transaction.
    expect(rpc).not.toHaveBeenCalled();
  });

  it("writes the app-level event through log_audit with secrets stripped", async () => {
    const { client, rpc } = fakeClient();
    await runMutation(
      context("owner", client),
      {
        ...renameSpec,
        run: async () => ({ id: ENTITY }),
        event: ({ result, data }) => ({
          action: "pii.reveal",
          entity: "workers",
          entityId: result.id,
          before: { nin_enc: "cipher", pin: "1234", name: "old" },
          after: { name: data.name, bank: { account_enc: "x", bank_code: "058" }, password: "p" },
          reason: "Payroll query",
        }),
      },
      { name: "Alpha" },
    );
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("log_audit", {
      p_organisation_id: ORG,
      p_action: "pii.reveal",
      p_entity: "workers",
      p_entity_id: ENTITY,
      p_before: { name: "old" },
      p_after: { name: "Alpha", bank: { bank_code: "058" } },
      p_reason: "Payroll query",
    });
  });

  it("writes no audit event when the change fails", async () => {
    const { client, rpc } = fakeClient();
    const error = await runMutation(
      context("owner", client),
      {
        ...renameSpec,
        run: async () => {
          throw new Error("permission denied for table organisations");
        },
        event: () => ({ action: "organisation.rename", entity: "organisations" }),
      },
      { name: "Alpha" },
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "failed" });
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses trigger-style event names before calling the database", async () => {
    const { client, rpc } = fakeClient();
    await expect(
      runMutation(
        context("owner", client),
        {
          ...renameSpec,
          run: async () => null,
          event: () => ({ action: "organisations.update", entity: "organisations" }),
        },
        { name: "Alpha" },
      ),
    ).rejects.toThrow(/triggers only/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("surfaces a log_audit failure", async () => {
    const { client } = fakeClient({ data: null, error: { message: "only managers" } });
    await expect(
      runMutation(
        context("owner", client),
        {
          ...renameSpec,
          run: async () => null,
          event: () => ({ action: "org.switch", entity: "organisations" }),
        },
        { name: "Alpha" },
      ),
    ).rejects.toThrow(/only managers/);
  });
});

describe("redactForAudit", () => {
  it("drops secret keys at any depth and keeps JSON values", () => {
    expect(
      redactForAudit({
        a: 1,
        b: [{ token_hash: "x", ok: true }],
        c: { client_secret: "s", nested: { rsa_pin_enc: "y", value: null } },
        d: undefined,
      }),
    ).toEqual({ a: 1, b: [{ ok: true }], c: { nested: { value: null } } });
  });
});
