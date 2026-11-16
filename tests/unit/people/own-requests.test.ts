/**
 * Slice 1.10: "Request a change" from the worker app. The worker id and organisation come from
 * the session context, never from the form; the account number is encrypted for the worker's
 * own column; long numbers never reach a free-text request; refusals use the worker's words.
 * And HR's "Mark done / Decline" is limited to owner, admin and hr.
 */
import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { workerMessages } from "@/lib/messages/worker";
import { decryptPii } from "@/server/crypto/pii";
import { MutationError, runMutation } from "@/server/identity/mutate";
import { bankAccountContext } from "@/server/people/bank-changes";
import { resolveChangeRequestSpec } from "@/server/people/change-requests";
import {
  runOwnBankChange,
  runOwnChangeRequest,
  type OwnContext,
} from "@/server/people/own-requests";
import type { Database } from "@/types/db";

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));

const ORG = "a0000000-0000-4000-8000-000000000001";
const WORKER = "b0000000-0000-4000-8000-000000000002";
const OTHER = "d0000000-0000-4000-8000-000000000004";
const ROW = "c0000000-0000-4000-8000-000000000003";
const NUBAN = "0123457712";
const copy = workerMessages.change;

type Result = { data: unknown; error: unknown };

function fakeSupabase(result: Result) {
  const calls: { table: string; op: string; payload: unknown; filters: unknown[][] }[] = [];
  function from(table: string) {
    const call = { table, op: "select", payload: undefined as unknown, filters: [] as unknown[][] };
    calls.push(call);
    const builder = {
      insert(payload: unknown) {
        call.op = "insert";
        call.payload = payload;
        return builder;
      },
      update(payload: unknown) {
        call.op = "update";
        call.payload = payload;
        return builder;
      },
      eq(column: string, value: unknown) {
        call.filters.push([column, value]);
        return builder;
      },
      select: () => builder,
      single: async () => result,
      maybeSingle: async () => result,
    };
    return builder;
  }
  return { client: { from } as unknown as SupabaseClient<Database>, calls };
}

function ctx(client: SupabaseClient<Database>): OwnContext {
  return { supabase: client, organisationId: ORG, workerId: WORKER };
}

async function refusal(promise: Promise<unknown>): Promise<MutationError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(MutationError);
  return error as MutationError;
}

beforeEach(() => {
  vi.stubEnv("PII_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a worker's own bank change", () => {
  const input = {
    // A form can't choose whose bank details change.
    workerId: OTHER,
    organisationId: OTHER,
    bankName: " GTBank ",
    accountName: "Musa Ibrahim",
    bankAccountNumber: "0123 457 712",
    reason: "",
  };

  it("is raised for the signed-in worker, encrypted for their own column", async () => {
    const fake = fakeSupabase({ data: { id: ROW }, error: null });
    await expect(runOwnBankChange(ctx(fake.client), input)).resolves.toEqual({ id: ROW });
    const [call] = fake.calls;
    expect(call).toMatchObject({ table: "bank_detail_changes", op: "insert" });
    const row = call!.payload as Record<string, string | null>;
    expect(row).toMatchObject({
      organisation_id: ORG,
      worker_id: WORKER,
      bank_name: "GTBank",
      account_name: "Musa Ibrahim",
      bank_account_last4: "7712",
      reason: null,
    });
    expect(Object.keys(row)).not.toContain("requested_by");
    expect(decryptPii(row.bank_account_enc!, bankAccountContext(ORG, WORKER))).toBe(NUBAN);
    expect(JSON.stringify(fake.calls)).not.toContain(NUBAN);
  });

  it("checks the fields in the worker's words before any write", async () => {
    const fake = fakeSupabase({ data: null, error: null });
    const error = await refusal(
      runOwnBankChange(ctx(fake.client), {
        ...input,
        bankName: "",
        accountName: "www.example.com",
        bankAccountNumber: "012345771",
      }),
    );
    expect(error.code).toBe("invalid");
    expect(error.fieldErrors).toEqual({
      bankName: copy.bankNameRequired,
      accountName: copy.accountNameNoLinks,
      bankAccountNumber: copy.accountNumberInvalid,
    });
    expect(fake.calls).toEqual([]);
  });

  it("explains a bank change that is already waiting", async () => {
    const fake = fakeSupabase({
      data: null,
      error: {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "bank_detail_changes_one_open_key"',
      },
    });
    const error = await refusal(runOwnBankChange(ctx(fake.client), input));
    expect(error.message).toBe(copy.bankWaiting);
  });

  it("says so when the worker has left", async () => {
    const fake = fakeSupabase({ data: null, error: { code: "MLBK5", message: "left" } });
    expect((await refusal(runOwnBankChange(ctx(fake.client), input))).message).toBe(copy.left);
  });
});

describe("a worker's change request", () => {
  it("is sent for the signed-in worker with the topic and their words", async () => {
    const fake = fakeSupabase({ data: { id: ROW }, error: null });
    await runOwnChangeRequest(ctx(fake.client), {
      workerId: OTHER,
      topic: "name",
      details: "  My surname is Adebayo,\r\nnot Adebayor  ",
    });
    expect(fake.calls[0]).toMatchObject({
      table: "worker_change_requests",
      op: "insert",
      payload: {
        organisation_id: ORG,
        worker_id: WORKER,
        topic: "name",
        details: "My surname is Adebayo,\nnot Adebayor",
      },
    });
  });

  it("refuses personal numbers, unknown topics and empty text before any write", async () => {
    const fake = fakeSupabase({ data: null, error: null });
    const numbers = await refusal(
      runOwnChangeRequest(ctx(fake.client), { topic: "nin", details: "It is 1234 5678 901" }),
    );
    expect(numbers.fieldErrors).toEqual({ details: copy.detailsNumbers });
    const topic = await refusal(
      runOwnChangeRequest(ctx(fake.client), { topic: "bank", details: "Change my bank" }),
    );
    expect(topic.fieldErrors).toEqual({ topic: copy.topicRequired });
    const empty = await refusal(
      runOwnChangeRequest(ctx(fake.client), { topic: "other", details: "   " }),
    );
    expect(empty.fieldErrors).toEqual({ details: copy.detailsRequired });
    expect(fake.calls).toEqual([]);
  });

  it("explains the limit of 5 waiting requests", async () => {
    const fake = fakeSupabase({ data: null, error: { code: "MLCR2", message: "limit" } });
    const error = await refusal(
      runOwnChangeRequest(ctx(fake.client), { topic: "other", details: "Please check my site" }),
    );
    expect(error.message).toBe(copy.tooMany);
  });
});

describe("HR dealing with a change request", () => {
  const input = { requestId: ROW, decision: "declined", note: "Bring your NIN slip to HR" };

  it("is for owner, admin and hr only", async () => {
    for (const role of ["finance", "ops_manager", "line_manager"] as const) {
      const fake = fakeSupabase({ data: null, error: null });
      const error = await refusal(
        runMutation(
          { supabase: fake.client, userId: "u", organisationId: ORG, role },
          resolveChangeRequestSpec,
          input,
        ),
      );
      expect(error.code).toBe("forbidden");
      expect(fake.calls).toEqual([]);
    }
  });

  it("moves only an open request in the active organisation", async () => {
    const fake = fakeSupabase({
      data: { id: ROW, worker_id: WORKER, status: "declined" },
      error: null,
    });
    const result = await runMutation(
      { supabase: fake.client, userId: "u", organisationId: ORG, role: "hr" },
      resolveChangeRequestSpec,
      input,
    );
    expect(result).toEqual({ id: ROW, workerId: WORKER, status: "declined" });
    expect(fake.calls[0]).toMatchObject({
      op: "update",
      payload: { status: "declined", resolution_note: "Bring your NIN slip to HR" },
      filters: [
        ["id", ROW],
        ["organisation_id", ORG],
        ["status", "open"],
      ],
    });
  });

  it("keeps personal numbers out of the note", async () => {
    const fake = fakeSupabase({ data: null, error: null });
    const error = await refusal(
      runMutation(
        { supabase: fake.client, userId: "u", organisationId: ORG, role: "owner" },
        resolveChangeRequestSpec,
        { ...input, note: "Updated to 08031234567" },
      ),
    );
    expect(error.code).toBe("invalid");
    expect(fake.calls).toEqual([]);
  });
});
