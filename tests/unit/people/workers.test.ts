import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decryptPii } from "@/server/crypto/pii";
import { MutationError, runMutation, type MutationContext } from "@/server/identity/mutate";
import {
  addPayRateSpec,
  cancelPayRateSpec,
  createWorkerSpec,
  endEmploymentSpec,
  updateWorkerSpec,
} from "@/server/people/workers";
import type { Database } from "@/types/db";

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));

const ORG = "a0000000-0000-4000-8000-000000000001";
const WORKER = "b0000000-0000-4000-8000-000000000002";
const MANAGER = "b0000000-0000-4000-8000-000000000003";
const NIN = "12345678901";
const NUBAN = "0123457712";
const RSA_PIN = "PEN100012344421";

type Result = { data: unknown; error: unknown };

interface FakeOptions {
  staffIds?: string[];
  phoneTaken?: boolean;
  rpc?: (name: string, args: Record<string, unknown>) => Result;
  updated?: Result;
}

/** A Supabase client double that records writes. Reads answer from `options`. */
function fakeSupabase(options: FakeOptions = {}) {
  const rpc = vi.fn(
    async (name: string, args: Record<string, unknown>) =>
      options.rpc?.(name, args) ?? { data: "new-id", error: null },
  );
  const updates: Record<string, unknown>[] = [];
  const reads: { select: string; filters: unknown[][] }[] = [];

  function from(table: string) {
    const state = { table, select: "", filters: [] as unknown[][], range: [0, 0] };
    const answer = (): Result => {
      if (state.select === "staff_id") {
        const ids = options.staffIds ?? [];
        const [start, end] = state.range as [number, number];
        return { data: ids.slice(start, end + 1).map((staff_id) => ({ staff_id })), error: null };
      }
      return { data: options.phoneTaken ? [{ id: "someone-else" }] : [], error: null };
    };
    const builder = {
      select(columns: string) {
        state.select = columns;
        reads.push(state);
        return builder;
      },
      update(patch: Record<string, unknown>) {
        updates.push(patch);
        return builder;
      },
      eq(column: string, value: unknown) {
        state.filters.push(["eq", column, value]);
        return builder;
      },
      neq(column: string, value: unknown) {
        state.filters.push(["neq", column, value]);
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      range(start: number, end: number) {
        state.range = [start, end];
        return builder;
      },
      maybeSingle: async () => options.updated ?? { data: { id: WORKER }, error: null },
      then(resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) {
        return Promise.resolve(answer()).then(resolve, reject);
      },
    };
    return builder;
  }

  const client = { rpc, from } as unknown as SupabaseClient<Database>;
  return { client, rpc, updates, reads };
}

function context(
  client: SupabaseClient<Database>,
  role: MutationContext["role"] = "hr",
): MutationContext {
  return { supabase: client, userId: "user-1", organisationId: ORG, role };
}

const ctx = (column: string, rowId: string) => ({
  organisationId: ORG,
  table: "workers",
  column,
  rowId,
});

const newWorker = {
  firstName: "Musa",
  lastName: "Ibrahim",
  phone: "0803 000 0002",
  employmentType: "permanent",
  startDate: "2024-03-03",
  bankName: "GTBank",
  accountName: "Musa Ibrahim",
  bankAccountNumber: NUBAN,
  nin: NIN,
  rsaPin: RSA_PIN,
  annualRentDeclared: "360,000",
  payType: "monthly",
  basic: "60000",
  housing: "36000",
  transport: "24000.50",
};

beforeEach(() => {
  vi.stubEnv("PII_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("createWorker", () => {
  it("encrypts personal data for the new row and sends no plaintext", async () => {
    const fake = fakeSupabase({ staffIds: ["CSL-0410", "CSL-0412"] });
    const result = await runMutation(context(fake.client), createWorkerSpec, newWorker);

    expect(result).toMatchObject({
      staffId: "CSL-0413",
      staffIdGenerated: true,
      supervisorClockIn: false,
    });
    expect(fake.rpc).toHaveBeenCalledTimes(1);
    const [name, args] = fake.rpc.mock.calls[0]!;
    expect(name).toBe("create_worker");
    const worker = args.p_worker as Record<string, string | null>;
    expect(worker).toMatchObject({
      id: result.id,
      organisation_id: ORG,
      staff_id: "CSL-0413",
      phone: "08030000002",
      bank_account_last4: "7712",
      rsa_pin_last4: "4421",
      annual_rent_declared_kobo: "36000000",
    });
    expect(decryptPii(worker.nin_enc!, ctx("nin_enc", result.id))).toBe(NIN);
    expect(decryptPii(worker.bank_account_enc!, ctx("bank_account_enc", result.id))).toBe(NUBAN);
    expect(decryptPii(worker.rsa_pin_enc!, ctx("rsa_pin_enc", result.id))).toBe(RSA_PIN);

    const sent = JSON.stringify(args);
    for (const secret of [NIN, NUBAN, RSA_PIN]) expect(sent).not.toContain(secret);
  });

  it("sends the first pay rate as whole kobo strings from the start date", async () => {
    const fake = fakeSupabase();
    await runMutation(context(fake.client), createWorkerSpec, {
      ...newWorker,
      staffId: "EMP-0007",
    });
    const [, args] = fake.rpc.mock.calls[0]!;
    expect(args.p_pay_rate).toEqual({
      pay_type: "monthly",
      basic_kobo: "6000000",
      housing_kobo: "3600000",
      transport_kobo: "2400050",
      other_allowances_kobo: "0",
      daily_rate_kobo: null,
      hourly_rate_kobo: null,
      effective_from: "2024-03-03",
    });
    expect((args.p_worker as Record<string, unknown>).staff_id).toBe("EMP-0007");
    // A given staff ID needs no lookup of the others.
    expect(fake.reads.some((read) => read.select === "staff_id")).toBe(false);
  });

  it("adds no pay rate when the pay fields are blank (needs pay details)", async () => {
    const fake = fakeSupabase();
    await runMutation(context(fake.client), createWorkerSpec, {
      firstName: "Kunle",
      lastName: "Ade",
      employmentType: "casual",
      startDate: "2026-09-15",
    });
    const [, args] = fake.rpc.mock.calls[0]!;
    expect(args.p_pay_rate).toBeUndefined();
    expect(args.p_worker).toMatchObject({
      staff_id: "EMP-0001",
      nin_enc: null,
      bank_account_enc: null,
    });
  });

  it("marks supervisor clock-in when another worker has the phone number", async () => {
    const fake = fakeSupabase({ phoneTaken: true });
    const result = await runMutation(context(fake.client), createWorkerSpec, newWorker);
    expect(result.supervisorClockIn).toBe(true);
    expect(fake.rpc.mock.calls[0]![1].p_worker).toMatchObject({ supervisor_clock_in: true });
  });

  it("retries a generated staff ID taken by a concurrent save", async () => {
    let calls = 0;
    const fake = fakeSupabase({
      staffIds: ["EMP-0001"],
      rpc: () => {
        calls += 1;
        return calls === 1
          ? {
              data: null,
              error: {
                code: "23505",
                message: 'duplicate key value violates unique constraint "workers_staff_id_key"',
              },
            }
          : { data: "id", error: null };
      },
    });
    const result = await runMutation(context(fake.client), createWorkerSpec, newWorker);
    expect(fake.rpc).toHaveBeenCalledTimes(2);
    expect(result.staffIdGenerated).toBe(true);
  });

  it("reports a staff ID the company already uses against the field", async () => {
    const fake = fakeSupabase({
      rpc: () => ({
        data: null,
        error: {
          code: "23505",
          message: 'duplicate key value violates unique constraint "workers_staff_id_key"',
        },
      }),
    });
    const error = await runMutation(context(fake.client), createWorkerSpec, {
      ...newWorker,
      staffId: "EMP-0001",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MutationError);
    expect(error).toMatchObject({
      code: "invalid",
      fieldErrors: { staffId: "Another employee already has this staff ID." },
    });
    expect(fake.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["MLLM1", "lineManagerWorkerId"],
    ["MLLM2", "lineManagerMembershipId"],
    ["MLPR2", "payEffectiveFrom"],
  ])("maps database refusal %s to the %s field", async (code, field) => {
    const fake = fakeSupabase({
      rpc: () => ({ data: null, error: { code, message: "Refused." } }),
    });
    const error = await runMutation(context(fake.client), createWorkerSpec, newWorker).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: "invalid", fieldErrors: { [field]: "Refused." } });
  });

  it.each(["finance", "ops_manager", "line_manager"] as const)(
    "refuses %s before touching anything",
    async (role) => {
      const fake = fakeSupabase();
      await expect(
        runMutation(context(fake.client, role), createWorkerSpec, newWorker),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(fake.rpc).not.toHaveBeenCalled();
    },
  );
});

describe("updateWorker", () => {
  it("re-encrypts changed personal data for the same row and clears the other line manager", async () => {
    const fake = fakeSupabase();
    const result = await runMutation(context(fake.client), updateWorkerSpec, {
      workerId: WORKER,
      nin: NIN,
      rsaPin: RSA_PIN,
      lineManagerMembershipId: MANAGER,
      jobTitle: "",
    });
    expect(result).toEqual({ id: WORKER, changed: true });
    const [patch] = fake.updates;
    expect(patch).toMatchObject({
      job_title: null,
      line_manager_worker_id: null,
      line_manager_membership_id: MANAGER,
      rsa_pin_last4: "4421",
    });
    expect(decryptPii(patch!.nin_enc as string, ctx("nin_enc", WORKER))).toBe(NIN);
    expect(decryptPii(patch!.rsa_pin_enc as string, ctx("rsa_pin_enc", WORKER))).toBe(RSA_PIN);
    expect(JSON.stringify(patch)).not.toContain(NIN);
  });

  it("keeps personal data unless it is cleared with null", async () => {
    const fake = fakeSupabase();
    await runMutation(context(fake.client), updateWorkerSpec, {
      workerId: WORKER,
      nin: "",
      rsaPin: null,
      annualRentDeclared: "600,000",
    });
    expect(fake.updates[0]).toEqual({
      rsa_pin_enc: null,
      rsa_pin_last4: null,
      annual_rent_declared_kobo: "60000000",
    });
  });

  it("refuses a staff ID change and writes nothing", async () => {
    const fake = fakeSupabase();
    const error = await runMutation(context(fake.client), updateWorkerSpec, {
      workerId: WORKER,
      staffId: "AFS-0042-OLD",
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid" });
    expect(fake.updates).toEqual([]);
  });

  it("refuses bank details: those changes need a second approver", async () => {
    const fake = fakeSupabase();
    const error = await runMutation(context(fake.client), updateWorkerSpec, {
      workerId: WORKER,
      bankAccountNumber: NUBAN,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid" });
    expect(fake.updates).toEqual([]);
  });

  it("switches on supervisor clock-in when the new phone is shared", async () => {
    const fake = fakeSupabase({ phoneTaken: true });
    await runMutation(context(fake.client), updateWorkerSpec, {
      workerId: WORKER,
      phone: "08030000009",
      supervisorClockIn: false,
    });
    expect(fake.updates[0]).toMatchObject({ phone: "08030000009", supervisor_clock_in: true });
  });

  it("writes nothing when nothing changed, and reports a worker it can't see", async () => {
    const fake = fakeSupabase();
    expect(await runMutation(context(fake.client), updateWorkerSpec, { workerId: WORKER })).toEqual(
      { id: WORKER, changed: false },
    );
    expect(fake.updates).toEqual([]);

    const hidden = fakeSupabase({ updated: { data: null, error: null } });
    await expect(
      runMutation(context(hidden.client), updateWorkerSpec, {
        workerId: WORKER,
        firstName: "Bola",
      }),
    ).rejects.toMatchObject({ code: "invalid", message: "That employee wasn't found." });
  });
});

describe("addPayRate", () => {
  it("passes the version to add_pay_rate with kobo as strings", async () => {
    const fake = fakeSupabase({ rpc: () => ({ data: "rate-id", error: null }) });
    const result = await runMutation(context(fake.client), addPayRateSpec, {
      workerId: WORKER,
      payType: "daily",
      dailyRate: "8,500.50",
      effectiveFrom: "2026-12-01",
    });
    expect(result).toEqual({ id: "rate-id" });
    expect(fake.rpc).toHaveBeenCalledWith("add_pay_rate", {
      p_organisation_id: ORG,
      p_worker_id: WORKER,
      p_rate: {
        pay_type: "daily",
        basic_kobo: null,
        housing_kobo: null,
        transport_kobo: null,
        other_allowances_kobo: null,
        daily_rate_kobo: "850050",
        hourly_rate_kobo: null,
        effective_from: "2026-12-01",
      },
    });
  });

  it("shows the database's refusal of a past edit against the date", async () => {
    const message =
      "A new pay rate can't start in the past once the worker has one. Start it today or later.";
    const fake = fakeSupabase({ rpc: () => ({ data: null, error: { code: "MLPR2", message } }) });
    await expect(
      runMutation(context(fake.client), addPayRateSpec, {
        workerId: WORKER,
        payType: "hourly",
        hourlyRate: "1500",
        effectiveFrom: "2020-01-01",
      }),
    ).rejects.toMatchObject({ code: "invalid", fieldErrors: { effectiveFrom: message } });
  });
});

describe("cancelPayRate", () => {
  const RATE = "c0000000-0000-4000-8000-000000000004";

  it("cancels in the active organisation only", async () => {
    const fake = fakeSupabase({ rpc: () => ({ data: null, error: null }) });
    expect(await runMutation(context(fake.client), cancelPayRateSpec, { payRateId: RATE })).toEqual(
      { id: RATE },
    );
    expect(fake.rpc).toHaveBeenCalledWith("cancel_pay_rate", {
      p_organisation_id: ORG,
      p_pay_rate_id: RATE,
    });
  });

  it("shows the database's refusal of a version in force", async () => {
    const message = "This pay rate is already in force and can't be removed.";
    const fake = fakeSupabase({ rpc: () => ({ data: null, error: { code: "MLPR1", message } }) });
    await expect(
      runMutation(context(fake.client), cancelPayRateSpec, { payRateId: RATE }),
    ).rejects.toMatchObject({ code: "invalid", fieldErrors: { payRateId: message } });
  });

  it("refuses finance before touching anything", async () => {
    const fake = fakeSupabase();
    await expect(
      runMutation(context(fake.client, "finance"), cancelPayRateSpec, { payRateId: RATE }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(fake.rpc).not.toHaveBeenCalled();
  });
});

describe("endEmployment", () => {
  it("ends employment in one call and audits the reason", async () => {
    const fake = fakeSupabase({
      rpc: (name) => ({ data: name === "log_audit" ? "audit-id" : null, error: null }),
    });
    await runMutation(context(fake.client), endEmploymentSpec, {
      workerId: WORKER,
      endDate: "2026-10-31",
      reason: "Resigned",
    });
    expect(fake.rpc).toHaveBeenNthCalledWith(1, "end_employment", {
      p_organisation_id: ORG,
      p_worker_id: WORKER,
      p_end_date: "2026-10-31",
    });
    expect(fake.rpc).toHaveBeenNthCalledWith(
      2,
      "log_audit",
      expect.objectContaining({
        p_organisation_id: ORG,
        p_action: "people.employment_ended",
        p_entity: "workers",
        p_entity_id: WORKER,
        p_after: { end_date: "2026-10-31" },
        p_reason: "Resigned",
      }),
    );
  });
});
