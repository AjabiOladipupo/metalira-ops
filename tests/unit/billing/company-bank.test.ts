import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COMPANY_BANK_APPROVERS,
  COMPANY_BANK_HOLD_HOURS,
  COMPANY_BANK_REQUESTERS,
  canRevealCompanyBank,
  firstAccountAllowed,
  formatCompanyAccount,
  holdCountdown,
  holdEndsAt,
  holdRunning,
  last4Matches,
  previewCompanyBankRequest,
  type CompanyBankState,
} from "@/lib/company-bank";
import { MANAGER_ROLES } from "@/lib/roles";
import {
  companyBankContext,
  decideCompanyBankSpec,
  requestCompanyBankSpec,
} from "@/server/billing/company-bank";
import { decideCompanyBankSchema, requestCompanyBankSchema } from "@/server/billing/schemas";
import { decryptPii, sealPii } from "@/server/crypto/pii";
import { MutationError, runMutation, type MutationContext } from "@/server/identity/mutate";
import type { Database } from "@/types/db";

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));

const ORG = "a0000000-0000-4000-8000-000000000001";
const ACCOUNT = "c0000000-0000-4000-8000-000000000003";
const CURRENT = "c0000000-0000-4000-8000-000000000004";
const NUBAN = "0123454410";

const EMPTY: CompanyBankState = {
  current: null,
  hasOpenRequest: false,
  setupCompleted: false,
  firstAccountUsed: false,
};
const DRAFT = {
  bankName: "GTBank",
  accountName: "ADEBAYO FACILITY SERVICES LTD",
  accountNumber: NUBAN,
};
const NOW = "2026-11-19T09:00:00.000Z";

beforeEach(() => {
  vi.stubEnv("PII_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("roles", () => {
  it("lets owner, admin and finance ask; only owner and finance approve and reveal", () => {
    expect([...COMPANY_BANK_REQUESTERS].sort()).toEqual(["admin", "finance", "owner"]);
    expect([...COMPANY_BANK_APPROVERS].sort()).toEqual(["finance", "owner"]);
    for (const role of MANAGER_ROLES) {
      expect(canRevealCompanyBank(role)).toBe(role === "owner" || role === "finance");
    }
  });
});

describe("masking and the last-4 check", () => {
  it("names an account by bank, masked number and account name", () => {
    expect(
      formatCompanyAccount({ bankName: "GTBank", accountName: "ADEBAYO LTD", last4: "4410" }),
    ).toBe("GTBank ••••4410 · ADEBAYO LTD");
  });

  it("accepts the number's own last four digits only", () => {
    expect(last4Matches(NUBAN, "4410")).toBe(true);
    expect(last4Matches(NUBAN, "4411")).toBe(false);
    expect(last4Matches(NUBAN, "441")).toBe(false);
    expect(last4Matches("", "")).toBe(false);
  });
});

describe("the 72-hour hold", () => {
  it("ends exactly 72 hours after approval", () => {
    expect(COMPANY_BANK_HOLD_HOURS).toBe(72);
    expect(holdEndsAt(NOW).toISOString()).toBe("2026-11-22T09:00:00.000Z");
    expect(() => holdEndsAt("not a date")).toThrow(RangeError);
  });

  it("runs until the moment it ends", () => {
    const end = "2026-11-22T09:00:00.000Z";
    expect(holdRunning(end, "2026-11-22T08:59:59.999Z")).toBe(true);
    expect(holdRunning(end, end)).toBe(false);
    expect(holdRunning(null, NOW)).toBe(false);
  });

  it("counts down in whole hours, rounded up", () => {
    const end = "2026-11-22T09:00:00.000Z";
    expect(holdCountdown(end, NOW)).toBe("3 days left");
    expect(holdCountdown(end, "2026-11-20T03:30:00.000Z")).toBe("2 days 6 hours left");
    expect(holdCountdown(end, "2026-11-22T07:00:00.000Z")).toBe("2 hours left");
    expect(holdCountdown(end, "2026-11-22T08:00:00.000Z")).toBe("1 hour left");
    expect(holdCountdown(end, "2026-11-22T08:30:00.000Z")).toBe("Less than an hour left");
    expect(holdCountdown(end, end)).toBeNull();
  });
});

describe("the first-account rule", () => {
  it("lets an owner alone add the first account while setup is unfinished", () => {
    expect(firstAccountAllowed("owner", EMPTY)).toBe(true);
  });

  it("is for owners only, before setup ends, once", () => {
    expect(firstAccountAllowed("admin", EMPTY)).toBe(false);
    expect(firstAccountAllowed("finance", EMPTY)).toBe(false);
    expect(firstAccountAllowed("owner", { ...EMPTY, setupCompleted: true })).toBe(false);
    expect(firstAccountAllowed("owner", { ...EMPTY, firstAccountUsed: true })).toBe(false);
  });
});

describe("previewCompanyBankRequest", () => {
  it("shows the first account taking effect at once, audited", () => {
    const preview = previewCompanyBankRequest(DRAFT, "owner", EMPTY, NOW);
    expect(preview).toMatchObject({
      ok: true,
      mode: "first_account",
      newAccount: "GTBank ••••4410 · ADEBAYO FACILITY SERVICES LTD",
      replaces: null,
      earliestEffectiveAt: NOW,
    });
  });

  it("shows a change waiting for a second person, then 72 hours", () => {
    const state: CompanyBankState = {
      current: { bankName: "Access Bank", accountName: "ADEBAYO LTD", last4: "1234" },
      hasOpenRequest: false,
      setupCompleted: true,
      firstAccountUsed: true,
    };
    const preview = previewCompanyBankRequest(DRAFT, "finance", state, NOW);
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.mode).toBe("needs_approval");
    expect(preview.replaces).toBe("Access Bank ••••1234 · ADEBAYO LTD");
    expect(preview.earliestEffectiveAt).toBe("2026-11-22T09:00:00.000Z");
    expect(preview.lines.join(" ")).toContain("other than you");
    expect(preview.lines.join(" ")).toContain("Access Bank ••••1234");
  });

  it("never returns the full number", () => {
    const preview = previewCompanyBankRequest(DRAFT, "admin", EMPTY, NOW);
    expect(JSON.stringify(preview)).not.toContain(NUBAN);
  });

  it("refuses other roles, bad numbers and a second open request", () => {
    expect(previewCompanyBankRequest(DRAFT, "hr", EMPTY, NOW).ok).toBe(false);
    expect(previewCompanyBankRequest(DRAFT, "ops_manager", EMPTY, NOW).ok).toBe(false);
    expect(
      previewCompanyBankRequest({ ...DRAFT, accountNumber: "12345" }, "owner", EMPTY, NOW).ok,
    ).toBe(false);
    expect(
      previewCompanyBankRequest(DRAFT, "admin", { ...EMPTY, hasOpenRequest: true }, NOW).ok,
    ).toBe(false);
  });
});

describe("schemas", () => {
  it("takes a 10-digit NUBAN, with spaces", () => {
    const parsed = requestCompanyBankSchema.parse({
      bankName: " GTBank ",
      accountName: "ADEBAYO LTD",
      bankAccountNumber: "0123 454 410",
      reason: "",
    });
    expect(parsed).toEqual({
      bankName: "GTBank",
      accountName: "ADEBAYO LTD",
      bankAccountNumber: NUBAN,
      reason: null,
    });
  });

  it("refuses web addresses and angle brackets in names", () => {
    for (const bankName of ["www.gtbank-verify.com", "<b>GTBank</b>", "https://x"]) {
      expect(
        requestCompanyBankSchema.safeParse({
          bankName,
          accountName: "A",
          bankAccountNumber: NUBAN,
        }).success,
      ).toBe(false);
    }
  });

  it("knows approve, reject and stop only", () => {
    expect(
      decideCompanyBankSchema.safeParse({ accountId: ACCOUNT, decision: "apply" }).success,
    ).toBe(false);
    expect(
      decideCompanyBankSchema.safeParse({ accountId: ACCOUNT, decision: "stop" }).success,
    ).toBe(true);
  });
});

type Result = { data: unknown; error: unknown };

/** A client double: `from()` chains answer `rows`; `rpc()` answers `rpcResult` and records. */
function fakeSupabase(rows: Result, rpcResult: Result = { data: [], error: null }) {
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => Promise.resolve(rows),
  };
  const client = {
    from: () => builder,
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return rpcResult;
    },
  } as unknown as SupabaseClient<Database>;
  return { client, rpcCalls };
}

function context(
  client: SupabaseClient<Database>,
  role: MutationContext["role"] = "finance",
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

describe("requestCompanyBankSpec", () => {
  it("seals the number for the new row and sends only its last four digits in clear", async () => {
    const { client, rpcCalls } = fakeSupabase(
      { data: [], error: null },
      { data: [{ id: "x", status: "pending", single_approver: false }], error: null },
    );
    const result = await runMutation(context(client, "admin"), requestCompanyBankSpec, {
      bankName: "GTBank",
      accountName: "ADEBAYO LTD",
      bankAccountNumber: NUBAN,
    });
    const call = rpcCalls[0]!;
    expect(call.name).toBe("request_org_bank_account");
    expect(call.args.p_bank_account_last4).toBe("4410");
    expect(JSON.stringify(call.args)).not.toContain(NUBAN);
    const id = call.args.p_id as string;
    expect(decryptPii(call.args.p_bank_account_enc as string, companyBankContext(ORG, id))).toBe(
      NUBAN,
    );
    expect(result.last4).toBe("4410");
  });

  it("refuses hr, operations and line managers before touching the database", async () => {
    for (const role of ["hr", "ops_manager", "line_manager"] as const) {
      const { client, rpcCalls } = fakeSupabase({ data: [], error: null });
      const error = await refusal(
        runMutation(context(client, role), requestCompanyBankSpec, {
          bankName: "GTBank",
          accountName: "A",
          bankAccountNumber: NUBAN,
        }),
      );
      expect(error.code).toBe("forbidden");
      expect(rpcCalls).toHaveLength(0);
    }
  });
});

describe("decideCompanyBankSpec: approval checks the number", () => {
  function pending(last4: string, number = NUBAN) {
    return {
      id: ACCOUNT,
      status: "pending",
      bank_name: "GTBank",
      account_name: "ADEBAYO LTD",
      bank_account_enc: sealPii(number, companyBankContext(ORG, ACCOUNT)).enc,
      bank_account_last4: last4,
    };
  }

  it("refuses an approval whose last four digits don't match the number", async () => {
    const { client, rpcCalls } = fakeSupabase({ data: [pending("9999")], error: null });
    const error = await refusal(
      runMutation(context(client), decideCompanyBankSpec, {
        accountId: ACCOUNT,
        decision: "approve",
      }),
    );
    expect(error.message).toContain("don't match");
    expect(rpcCalls).toHaveLength(0);
  });

  it("refuses a number sealed for another row", async () => {
    const row = {
      ...pending("4410"),
      bank_account_enc: sealPii(NUBAN, companyBankContext(ORG, CURRENT)).enc,
    };
    const { client, rpcCalls } = fakeSupabase({ data: [row], error: null });
    const error = await refusal(
      runMutation(context(client), decideCompanyBankSpec, {
        accountId: ACCOUNT,
        decision: "approve",
      }),
    );
    expect(error.message).toContain("can't be checked");
    expect(rpcCalls).toHaveLength(0);
  });

  it("refuses the account already in use", async () => {
    const current = {
      id: CURRENT,
      status: "active",
      bank_name: "gtbank",
      account_name: "Adebayo Ltd",
      bank_account_enc: sealPii(NUBAN, companyBankContext(ORG, CURRENT)).enc,
      bank_account_last4: "4410",
    };
    const { client } = fakeSupabase({ data: [pending("4410"), current], error: null });
    const error = await refusal(
      runMutation(context(client), decideCompanyBankSpec, {
        accountId: ACCOUNT,
        decision: "approve",
      }),
    );
    expect(error.message).toContain("already in use");
  });

  it("approves a matching request through the database function", async () => {
    const { client, rpcCalls } = fakeSupabase(
      { data: [pending("4410")], error: null },
      {
        data: [
          {
            id: ACCOUNT,
            status: "approved",
            applies_after: "2026-11-22T09:00:00Z",
            bank_account_last4: "4410",
          },
        ],
        error: null,
      },
    );
    const result = await runMutation(context(client, "owner"), decideCompanyBankSpec, {
      accountId: ACCOUNT,
      decision: "approve",
    });
    expect(rpcCalls[0]).toMatchObject({
      name: "decide_org_bank_account",
      args: { p_organisation_id: ORG, p_id: ACCOUNT, p_decision: "approve" },
    });
    expect(result.status).toBe("approved");
  });

  it("maps the database's refusal of the requester to a plain message", async () => {
    const { client } = fakeSupabase(
      { data: [pending("4410")], error: null },
      {
        data: null,
        error: {
          code: "MLOB1",
          message: "You raised this request, so someone else must approve or reject it.",
        },
      },
    );
    const error = await refusal(
      runMutation(context(client, "owner"), decideCompanyBankSpec, {
        accountId: ACCOUNT,
        decision: "approve",
      }),
    );
    expect(error.code).toBe("invalid");
    expect(error.message).toContain("someone else");
  });

  it("refuses admin as an approver", async () => {
    const { client } = fakeSupabase({ data: [pending("4410")], error: null });
    const error = await refusal(
      runMutation(context(client, "admin"), decideCompanyBankSpec, {
        accountId: ACCOUNT,
        decision: "approve",
      }),
    );
    expect(error.code).toBe("forbidden");
  });
});
