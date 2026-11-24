/**
 * Slice 5.4 (CLAUDE.md rules 6 and 9; docs/PHASE_5.md 5.4): a bank file run never puts an account
 * number in the server's log. The secret-key client and the user's client are mocked; the numbers
 * are real ciphertext under a test key, so the file is made exactly as in production. Every
 * console channel and stdout/stderr are captured through a successful run, a last-4 mismatch, an
 * unreadable number and a database refusal; none holds a number (or its ciphertext). The file's
 * bytes (positive control) do hold them, and what goes to the database holds only last 4 digits.
 */
import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "a0000000-0000-4000-8000-000000000001";
const USER = "b0000000-0000-4000-8000-000000000002";
const RUN = "c0000000-0000-4000-8000-000000000003";
const W1 = "d0000000-0000-4000-8000-000000000004";
const W2 = "d0000000-0000-4000-8000-000000000005";
const W3 = "d0000000-0000-4000-8000-000000000006";
const NUMBERS = { [W1]: "0123456789", [W2]: "8012345671", [W3]: "3029384756" } as const;

const uploads: { path: string; bytes: Buffer }[] = [];
const removed: string[] = [];
const plan = { rows: [] as Record<string, unknown>[] };
/** Whether the batch exists when the server re-checks after an unexpected failure. */
const recorded = { batch: false };

vi.mock("@/server/supabase/admin", () => ({
  createAdminSupabase: () => ({
    rpc: async (name: string) =>
      name === "payout_plan"
        ? { data: plan.rows, error: null }
        : name === "payroll_files_due"
          ? { data: [], error: null }
          : { data: null, error: { code: "XX000", message: "unexpected" } },
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: recorded.batch ? { id: "x" } : null, error: null }),
      };
      return builder;
    },
    storage: {
      from: () => ({
        upload: async (path: string, bytes: Uint8Array) => {
          uploads.push({ path, bytes: Buffer.from(bytes) });
          return { data: { path }, error: null };
        },
        remove: async (paths: string[]) => {
          removed.push(...paths);
          return { data: [], error: null };
        },
        createSignedUrl: async () => ({ data: { signedUrl: "https://x/y" }, error: null }),
      }),
    },
  }),
}));

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("@/server/identity/session", () => ({ getSession: async () => null }));

const { encryptPiiForDb } = await import("@/server/crypto/pii");
const { runMutation } = await import("@/server/identity/mutate");
const { makeBankFileSpec } = await import("@/server/payroll/payouts");

const runRecord = {
  id: RUN,
  kind: "regular",
  status: "approved",
  period_start: "2026-09-20",
  period_end: "2026-10-19",
  pay_date: "2026-10-25",
  rule_set_id: "e0000000-0000-4000-8000-000000000007",
  itf_applies: false,
  inputs_sha256: "a".repeat(64),
  needs_recalculation: false,
  calculated_at: "2026-10-20T08:00:00Z",
  calculated_by: "f0000000-0000-4000-8000-000000000008",
  prepared_by: "f0000000-0000-4000-8000-000000000008",
  submitted_at: "2026-10-20T08:00:00Z",
  submitted_by: "f0000000-0000-4000-8000-000000000008",
  approved_at: "2026-10-21T08:00:00Z",
  approved_by: USER,
  released_at: null,
  released_by: null,
  created_at: "2026-10-20T08:00:00Z",
  worker_count: 3,
  gross_kobo: "0",
  paye_kobo: "0",
  pension_employee_kobo: "0",
  pension_employer_kobo: "0",
  nhf_kobo: "0",
  other_deductions_kobo: "0",
  net_kobo: "29999700",
  nsitf_kobo: "0",
  itf_kobo: "0",
  employer_cost_kobo: "0",
  carried_forward_kobo: "0",
};

const userRpc = vi.fn();
const makeResult = { current: null as unknown };
/** The user's own read of the plan has no ciphertext (security review L1). */
const userPlan = () => plan.rows.map((r) => ({ ...r, bank_account_enc: null }));
function userClient() {
  return {
    from: (table: string) => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({
          data: table === "payroll_runs" ? runRecord : null,
          error: null,
        }),
      };
      return builder;
    },
    rpc: async (name: string, args: unknown) => {
      userRpc(name, args);
      if (name === "payout_plan") return { data: userPlan(), error: null };
      return makeResult.current;
    },
  };
}

function planRow(workerId: string, name: string, staffId: string, last4: string, net: string) {
  return {
    payslip_id: workerId.replace(/^d/, "9"),
    worker_id: workerId,
    worker_name: name,
    staff_id: staffId,
    net_kobo: net,
    bank_name: "GTBank",
    bank_code: "058",
    account_name: name.toUpperCase(),
    bank_account_last4: last4,
    bank_detail_change_id: null,
    bank_account_enc: encryptPiiForDb(NUMBERS[workerId as keyof typeof NUMBERS], {
      organisationId: ORG,
      table: "workers",
      column: "bank_account_enc",
      rowId: workerId,
    }),
    on_file: true,
    in_hold: false,
    acknowledged_code: null,
  };
}

let logged: string[] = [];
const spies: { mockRestore: () => void }[] = [];

function capture() {
  logged = [];
  const record = (...args: unknown[]) => {
    logged.push(
      args
        .map((a) => {
          if (a instanceof Error) return `${a.name}: ${a.message} ${String(a.stack)}`;
          try {
            return typeof a === "string" ? a : JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" "),
    );
  };
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    spies.push(vi.spyOn(console, method).mockImplementation(record));
  }
  const write = (chunk: unknown) => {
    record(String(chunk));
    return true;
  };
  spies.push(vi.spyOn(process.stdout, "write").mockImplementation(write));
  spies.push(vi.spyOn(process.stderr, "write").mockImplementation(write));
}

function expectNoNumbers(extra: string[] = []) {
  const text = [...logged, ...extra].join("\n");
  for (const n of Object.values(NUMBERS)) expect(text).not.toContain(n);
  for (const r of plan.rows) expect(text).not.toContain(String(r.bank_account_enc).slice(2, 40));
  // The log holds no run of ten digits at all (ids and hashes may, outside the log).
  expect(logged.join(" | ")).not.toMatch(/\d{10}/);
}

/** The run's refusal: the error `makeBankFileSpec` throws. */
async function refused(): Promise<Error & { cause?: unknown }> {
  try {
    await runMutation(ctx(), makeBankFileSpec, { runId: RUN, format: "generic-csv" });
  } catch (error) {
    return error as Error & { cause?: unknown };
  }
  throw new Error("expected the file to be refused");
}

const ctx = () => ({
  supabase: userClient() as never,
  userId: USER,
  organisationId: ORG,
  role: "finance" as const,
});

beforeEach(() => {
  vi.stubEnv("PII_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  uploads.length = 0;
  removed.length = 0;
  userRpc.mockReset();
  recorded.batch = false;
  makeResult.current = { data: null, error: { code: "XX000", message: "unexpected" } };
  plan.rows = [
    planRow(W1, "Musa Ibrahim", "MLS-0001", "6789", "10474000"),
    planRow(W2, "Grace Edet", "MLS-0002", "5671", "9521050"),
    planRow(W3, "Ada Obi", "MLS-0003", "4756", "10004650"),
  ];
  capture();
});

afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  vi.unstubAllEnvs();
});

describe("a bank file run logs no account number", () => {
  it("makes the file: numbers in its bytes only, never in the log or the database call", async () => {
    makeResult.current = {
      data: { batch_id: "x", item_count: 3, total_kobo: "29999700", left_out_count: 0 },
      error: null,
    };
    const made = await runMutation(ctx(), makeBankFileSpec, {
      runId: RUN,
      format: "generic-csv",
    });
    expect(made).toMatchObject({ itemCount: 3, totalKobo: "29999700", leftOutCount: 0 });
    expect(made.sha256).toMatch(/^[0-9a-f]{64}$/);

    // Positive control: the file holds every number.
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.path).toBe(`${ORG}/${RUN}/${made.batchId}.csv`);
    const file = uploads[0]!.bytes.toString("utf8");
    for (const n of Object.values(NUMBERS)) expect(file).toContain(n);
    expect(file).toContain("104740.00");

    // The database gets last 4 digits only.
    // The user's own read came first (security review L1), then the record.
    expect(userRpc.mock.calls.map(([n]) => n)).toEqual(["payout_plan", "make_payout_batch"]);
    const [name, args] = userRpc.mock.calls[1]!;
    expect(name).toBe("make_payout_batch");
    const sent = JSON.stringify(args);
    expect(sent).toContain('"bank_account_last4":"6789"');
    expectNoNumbers([sent, JSON.stringify(made)]);
  });

  it("refuses a last-4 mismatch by name, without the number", async () => {
    plan.rows[1]!.bank_account_last4 = "0000";
    const error = await refused();
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("Grace Edet");
    expect(error.message).toContain("doesn't match its last 4 digits");
    expect(uploads).toHaveLength(0);
    expect(userRpc.mock.calls.map(([n]) => n)).toEqual(["payout_plan"]);
    expectNoNumbers([error.message, String(error.stack)]);
  });

  it("refuses an unreadable number by name", async () => {
    plan.rows[0]!.bank_account_enc = plan.rows[2]!.bank_account_enc; // another worker's bytes
    const error = await refused();
    expect(error.message).toContain("Musa Ibrahim");
    expect(error.message).toContain("can't be read");
    expectNoNumbers([error.message, String(error.stack)]);
  });

  it("deletes the stored file when the database refuses, and logs no number", async () => {
    makeResult.current = {
      data: null,
      error: { code: "MLBF4", message: "The file doesn't match. Try again." },
    };
    const error = await refused();
    expect(error.message).toContain("Try again");
    expect(removed).toEqual([uploads[0]!.path]);
    expectNoNumbers([error.message]);
  });

  it("fails closed by name when the key is missing", async () => {
    vi.stubEnv("PII_ENCRYPTION_KEY", "");
    const error = await refused();
    expect(error.message).toBe("The change was not saved.");
    expect((error.cause as Error).message).toBe("PiiKeyError");
    expect(uploads).toHaveLength(0);
    expectNoNumbers([String((error.cause as Error).stack)]);
  });

  it("keeps the stored file after an unexpected failure when the batch was recorded", async () => {
    makeResult.current = { data: null, error: { code: "08006", message: "connection lost" } };
    recorded.batch = true;
    const kept = await refused();
    expect(kept.message).toBe("The change was not saved.");
    expect(removed).toEqual([]);

    recorded.batch = false;
    await refused();
    expect(removed).toEqual([uploads[1]!.path]);
    expectNoNumbers();
  });
});
