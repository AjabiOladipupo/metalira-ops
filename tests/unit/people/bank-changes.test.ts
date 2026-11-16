import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decryptPii, sealPii } from "@/server/crypto/pii";
import { MutationError, runMutation, type MutationContext } from "@/server/identity/mutate";
import {
  BANK_CHANGE_APPROVERS,
  BANK_CHANGE_HOLD_HOURS,
  bankAccountContext,
  canViewBankChanges,
  decideBankChangeSpec,
  isBankChangeApprover,
  requestBankChangeSpec,
  withdrawBankChangeSpec,
} from "@/server/people/bank-changes";
import type { Database } from "@/types/db";

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));

const ORG = "a0000000-0000-4000-8000-000000000001";
const WORKER = "b0000000-0000-4000-8000-000000000002";
const CHANGE = "c0000000-0000-4000-8000-000000000003";
const NUBAN = "0123457712";

type Result = { data: unknown; error: unknown };

/**
 * A Supabase client double. Each `from()` chain answers with the next result in turn (the last
 * one repeats). Records what was sent.
 */
function fakeSupabase(results: Result | Result[]) {
  const queue = Array.isArray(results) ? [...results] : [results];
  const calls: { table: string; op: string; payload: unknown; filters: unknown[][] }[] = [];
  function from(table: string) {
    const call = { table, op: "select", payload: undefined as unknown, filters: [] as unknown[][] };
    calls.push(call);
    const result = (queue.length > 1 ? queue.shift() : queue[0])!;
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

function context(
  client: SupabaseClient<Database>,
  role: MutationContext["role"] = "hr",
): MutationContext {
  return { supabase: client, userId: "user-1", organisationId: ORG, role };
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
  vi.clearAllMocks();
});

describe("roles", () => {
  it("lets owner, hr and finance approve, never admin, operations or line managers", () => {
    expect([...BANK_CHANGE_APPROVERS].sort()).toEqual(["finance", "hr", "owner"]);
    for (const role of ["admin", "ops_manager", "line_manager"] as const) {
      expect(isBankChangeApprover(role)).toBe(false);
    }
    expect(canViewBankChanges("admin")).toBe(true);
    expect(canViewBankChanges("ops_manager")).toBe(false);
  });

  it("holds an approved change for 72 hours (owner decision 9)", () => {
    expect(BANK_CHANGE_HOLD_HOURS).toBe(72);
  });
});

describe("requestBankChange", () => {
  const input = {
    workerId: WORKER,
    bankName: " GTBank ",
    accountName: "Musa Ibrahim",
    bankAccountNumber: "0123 457 712",
    reason: "Moved banks",
  };

  it("encrypts the number for the worker's own column and sends no plaintext", async () => {
    const fake = fakeSupabase({ data: { id: CHANGE }, error: null });
    const result = await runMutation(context(fake.client), requestBankChangeSpec, input);

    expect(result).toEqual({ id: CHANGE, workerId: WORKER });
    const [call] = fake.calls;
    expect(call).toMatchObject({ table: "bank_detail_changes", op: "insert" });
    const row = call!.payload as Record<string, string>;
    expect(row).toMatchObject({
      organisation_id: ORG,
      worker_id: WORKER,
      bank_name: "GTBank",
      account_name: "Musa Ibrahim",
      bank_account_last4: "7712",
      reason: "Moved banks",
    });
    // No requester, status or decision columns: the database sets those itself.
    expect(Object.keys(row).sort()).toEqual(
      [
        "account_name",
        "bank_account_enc",
        "bank_account_last4",
        "bank_name",
        "organisation_id",
        "reason",
        "worker_id",
      ].sort(),
    );
    expect(decryptPii(row.bank_account_enc!, bankAccountContext(ORG, WORKER))).toBe(NUBAN);
    expect(JSON.stringify(fake.calls)).not.toContain(NUBAN);
  });

  it("refuses finance, operations and line managers before any write", async () => {
    for (const role of ["finance", "ops_manager", "line_manager"] as const) {
      const fake = fakeSupabase({ data: null, error: null });
      const error = await refusal(
        runMutation(context(fake.client, role), requestBankChangeSpec, input),
      );
      expect(error.code).toBe("forbidden");
      expect(fake.calls).toEqual([]);
    }
  });

  it("checks the account number and the other fields", async () => {
    const fake = fakeSupabase({ data: null, error: null });
    const error = await refusal(
      runMutation(context(fake.client), requestBankChangeSpec, {
        ...input,
        bankAccountNumber: "012345771",
        accountName: "",
      }),
    );
    expect(error.fieldErrors).toMatchObject({
      bankAccountNumber: "Bank account numbers are 10 digits",
      accountName: "Enter the account name",
    });
  });

  it("explains a second open request against the account number field", async () => {
    const fake = fakeSupabase({
      data: null,
      error: {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "bank_detail_changes_one_open_key"',
      },
    });
    const error = await refusal(runMutation(context(fake.client), requestBankChangeSpec, input));
    expect(error.code).toBe("invalid");
    expect(error.fieldErrors.bankAccountNumber).toMatch(/already waiting/);
  });

  it("passes on the database's refusal for an employee who has left", async () => {
    const message = "This employee has left, so their bank details can't change.";
    const fake = fakeSupabase({ data: null, error: { code: "MLBK5", message } });
    const error = await refusal(runMutation(context(fake.client), requestBankChangeSpec, input));
    expect(error).toMatchObject({ code: "invalid", message });
  });
});

describe("decideBankChange", () => {
  const approved = {
    id: CHANGE,
    worker_id: WORKER,
    status: "approved",
    applies_after: "2026-11-19T13:05:00+00:00",
    bank_account_last4: "7712",
  };

  /** A pending request as the approval check reads it, with the worker's current details. */
  function pendingRequest(
    overrides: Record<string, unknown> = {},
    number = NUBAN,
    current: Record<string, unknown> | null = {
      bank_name: "Access Bank",
      account_name: "Musa Ibrahim",
      bank_account_enc: sealPii("0987651234", bankAccountContext(ORG, WORKER)).enc,
    },
  ): Result {
    return {
      data: {
        worker_id: WORKER,
        status: "pending",
        bank_name: "GTBank",
        account_name: "Musa Ibrahim",
        bank_account_enc: sealPii(number, bankAccountContext(ORG, WORKER)).enc,
        bank_account_last4: "7712",
        workers: current,
        ...overrides,
      },
      error: null,
    };
  }

  it.each([
    ["approve", "pending", "approved"],
    ["reject", "pending", "rejected"],
    ["stop", "approved", "cancelled"],
  ])("%s moves %s to %s, and sends only the status and note", async (decision, from, to) => {
    const updated = { data: { ...approved, status: to }, error: null };
    const fake = fakeSupabase(decision === "approve" ? [pendingRequest(), updated] : updated);
    const result = await runMutation(context(fake.client, "finance"), decideBankChangeSpec, {
      changeId: CHANGE,
      decision,
      note: "Checked the letter",
    });
    expect(result.status).toBe(to);
    const call = fake.calls.at(-1);
    expect(call).toMatchObject({
      op: "update",
      payload: { status: to, decision_note: "Checked the letter" },
    });
    expect(call!.filters).toEqual([
      ["id", CHANGE],
      ["organisation_id", ORG],
      ["status", from],
    ]);
    // Only an approval decrypts the request first; reject and stop write straight away.
    expect(fake.calls.map((c) => c.op)).toEqual(
      decision === "approve" ? ["select", "update"] : ["update"],
    );
  });

  describe("checks the account before an approval", () => {
    async function approve(fake: ReturnType<typeof fakeSupabase>) {
      return refusal(
        runMutation(context(fake.client, "finance"), decideBankChangeSpec, {
          changeId: CHANGE,
          decision: "approve",
        }),
      );
    }

    it("refuses last four digits that don't belong to the encrypted number", async () => {
      // A requester re-used another request's ciphertext (an account ending 9153) and wrote
      // the worker's current last four digits beside it, so the card would show no change.
      const fake = fakeSupabase(pendingRequest({ bank_account_last4: "1234" }, "2000009153"));
      const error = await approve(fake);
      expect(error.code).toBe("invalid");
      expect(error.message).toMatch(/don't match its account number/);
      expect(fake.calls.map((c) => c.op)).toEqual(["select"]);
      expect(fake.calls[0]!.filters).toEqual([
        ["id", CHANGE],
        ["organisation_id", ORG],
      ]);
    });

    it("refuses a number encrypted for another worker or column", async () => {
      const elsewhere = sealPii(NUBAN, bankAccountContext(ORG, CHANGE)).enc;
      const fake = fakeSupabase(pendingRequest({ bank_account_enc: elsewhere }));
      const error = await approve(fake);
      expect(error.message).toMatch(/can't be checked/);
      expect(fake.calls.map((c) => c.op)).toEqual(["select"]);
    });

    it("refuses a request that changes nothing", async () => {
      const sameAccount = {
        bank_name: "gtbank ",
        account_name: "Musa Ibrahim",
        bank_account_enc: sealPii(NUBAN, bankAccountContext(ORG, WORKER)).enc,
      };
      const fake = fakeSupabase(pendingRequest({}, NUBAN, sameAccount));
      const error = await approve(fake);
      expect(error.message).toMatch(/already on file/);
      expect(fake.calls.map((c) => c.op)).toEqual(["select"]);
    });

    it("allows a corrected account name on the same number, and a first account", async () => {
      for (const current of [
        {
          bank_name: "GTBank",
          account_name: "Musa Ibrahim Bello",
          bank_account_enc: sealPii(NUBAN, bankAccountContext(ORG, WORKER)).enc,
        },
        { bank_name: null, account_name: null, bank_account_enc: null },
      ]) {
        const updated = { data: approved, error: null };
        const fake = fakeSupabase([pendingRequest({}, NUBAN, current), updated]);
        const result = await runMutation(context(fake.client, "owner"), decideBankChangeSpec, {
          changeId: CHANGE,
          decision: "approve",
        });
        expect(result.status).toBe("approved");
      }
    });

    it("says so when the request is no longer pending", async () => {
      const fake = fakeSupabase(pendingRequest({ status: "rejected" }));
      const error = await approve(fake);
      expect(error.message).toMatch(/already decided/);
      expect(fake.calls.map((c) => c.op)).toEqual(["select"]);
    });
  });

  it("refuses admins and operations managers before any write", async () => {
    for (const role of ["admin", "ops_manager"] as const) {
      const fake = fakeSupabase({ data: null, error: null });
      const error = await refusal(
        runMutation(context(fake.client, role), decideBankChangeSpec, {
          changeId: CHANGE,
          decision: "approve",
        }),
      );
      expect(error.code).toBe("forbidden");
      expect(fake.calls).toEqual([]);
    }
  });

  it("passes on the database's refusal when the requester approves their own request", async () => {
    const message = "You raised this request, so someone else must approve or reject it.";
    const fake = fakeSupabase({ data: null, error: { code: "MLBK1", message } });
    const error = await refusal(
      runMutation(context(fake.client), decideBankChangeSpec, {
        changeId: CHANGE,
        decision: "approve",
      }),
    );
    expect(error).toMatchObject({ code: "invalid", message });
  });

  it("says so when the request was already decided", async () => {
    const fake = fakeSupabase({ data: null, error: null });
    const error = await refusal(
      runMutation(context(fake.client, "owner"), decideBankChangeSpec, {
        changeId: CHANGE,
        decision: "reject",
      }),
    );
    expect(error.message).toMatch(/already decided/);
  });
});

describe("withdrawBankChange", () => {
  it("cancels only a pending request", async () => {
    const fake = fakeSupabase({ data: { id: CHANGE, worker_id: WORKER }, error: null });
    await runMutation(context(fake.client, "admin"), withdrawBankChangeSpec, { changeId: CHANGE });
    expect(fake.calls[0]).toMatchObject({ op: "update", payload: { status: "cancelled" } });
    expect(fake.calls[0]!.filters).toContainEqual(["status", "pending"]);
  });
});
