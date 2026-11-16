import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { admin, sendApplied, sendApproved } = vi.hoisted(() => ({
  admin: { results: {} as Record<string, unknown[]>, calls: [] as Call[] },
  sendApplied: vi.fn(),
  sendApproved: vi.fn(),
}));

interface Call {
  table: string;
  op: string;
  payload?: unknown;
  filters: unknown[][];
}

/**
 * A secret-key client double: every chain is awaitable and answers with the next result queued
 * for its table and operation ("bank_detail_changes.select", "audit_log.select", ...).
 */
vi.mock("@/server/supabase/admin", () => ({
  createAdminSupabase: () => ({
    from(table: string) {
      const call: Call = { table, op: "select", filters: [] };
      admin.calls.push(call);
      const builder: Record<string, unknown> = {};
      for (const name of ["select", "order", "limit"]) builder[name] = () => builder;
      for (const name of ["eq", "is", "gte", "in"]) {
        builder[name] = (column: string, value: unknown) => {
          call.filters.push([name, column, value]);
          return builder;
        };
      }
      builder.update = (payload: unknown) => {
        call.op = "update";
        call.payload = payload;
        return builder;
      };
      builder.then = (resolve: (value: unknown) => unknown) => {
        const queue = admin.results[`${table}.${call.op}`] ?? [];
        return Promise.resolve(queue.shift() ?? { data: null, error: null }).then(resolve);
      };
      builder.maybeSingle = () => builder;
      return builder;
    },
  }),
}));

vi.mock("@/server/email/bank-changes", () => ({
  sendBankChangeAppliedEmail: sendApplied,
  sendBankChangeApprovedEmail: sendApproved,
  sendBankChangeRequestedEmail: vi.fn(),
}));

import {
  APPLIED_NOTICE_RETRY_DAYS,
  notifyWorkerOfBankChangeApproval,
  sendAppliedBankChangeNotices,
} from "@/server/people/bank-change-notices";

const ORG = "a0000000-0000-4000-8000-000000000001";
const WORKER = "b0000000-0000-4000-8000-000000000002";
const CHANGE = "c0000000-0000-4000-8000-000000000003";
const DAY = 86_400_000;

function change(overrides: Record<string, unknown> = {}) {
  return {
    id: CHANGE,
    organisation_id: ORG,
    worker_id: WORKER,
    requested_by: "d0000000-0000-4000-8000-000000000004",
    raised_by_worker: false,
    status: "applied",
    bank_account_last4: "9153",
    created_at: new Date(Date.now() - 4 * DAY).toISOString(),
    applies_after: new Date(Date.now() - DAY).toISOString(),
    applied_at: new Date(Date.now() - DAY).toISOString(),
    workers: {
      first_name: "Musa",
      last_name: "Ibrahim",
      staff_id: "MO-0114",
      email: "hr.controlled@example.com",
    },
    organisations: { name: "Apapa Guards" },
    ...overrides,
  };
}

/** The worker's email history in the row audit: HR repointed it the day before the request. */
const repointed = {
  data: [
    {
      before: { email: "musa@example.com", first_name: "Musa" },
      after: { email: "hr.controlled@example.com", first_name: "Musa" },
    },
    // A change to something else keeps the same address on both sides.
    { before: { email: "MUSA@example.com" }, after: { email: "MUSA@example.com" } },
  ],
  error: null,
};

const marks = () =>
  admin.calls.filter((c) => c.table === "bank_detail_changes" && c.op === "update");

beforeEach(() => {
  admin.results = {};
  admin.calls = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  sendApplied.mockReset();
  sendApproved.mockReset();
});

describe("worker notices go to former addresses too", () => {
  it("emails the approval to the current address and the one HR replaced", async () => {
    const approved = change({ status: "approved", applies_after: new Date().toISOString() });
    admin.results = {
      "bank_detail_changes.select": [
        {
          data: approved,
          error: null,
        },
      ],
      "audit_log.select": [repointed],
    };
    expect(await notifyWorkerOfBankChangeApproval(ORG, CHANGE)).toBe(2);
    expect(sendApproved.mock.calls.map(([input]) => (input as { to: string }).to)).toEqual([
      "hr.controlled@example.com",
      "musa@example.com",
    ]);
    // The history read is for this worker, in this organisation, from 90 days before the request.
    const history = admin.calls.find((c) => c.table === "audit_log")!;
    expect(history.filters).toEqual(
      expect.arrayContaining([
        ["eq", "organisation_id", ORG],
        ["eq", "entity", "workers"],
        ["eq", "entity_id", WORKER],
        ["eq", "action", "workers.update"],
      ]),
    );
    const since = history.filters.find(([op]) => op === "gte")![2] as string;
    expect(Date.parse(approved.created_at) - Date.parse(since)).toBe(90 * DAY);
  });

  it("still warns the worker when HR cleared their email", async () => {
    admin.results = {
      "bank_detail_changes.select": [
        {
          data: [change({ workers: { ...change().workers, email: null } })],
          error: null,
        },
      ],
      "audit_log.select": [
        { data: [{ before: { email: "musa@example.com" }, after: { email: null } }], error: null },
      ],
    };
    expect(await sendAppliedBankChangeNotices(ORG)).toBe(1);
    expect(sendApplied).toHaveBeenCalledWith(expect.objectContaining({ to: "musa@example.com" }));
  });
});

describe("applied notices", () => {
  it("marks a change notified only after its emails went", async () => {
    admin.results = {
      "bank_detail_changes.select": [{ data: [change()], error: null }],
      "audit_log.select": [{ data: [], error: null }],
    };
    expect(await sendAppliedBankChangeNotices(ORG)).toBe(1);
    expect(marks()).toHaveLength(1);
    expect(marks()[0]!.filters).toEqual([
      ["eq", "id", CHANGE],
      ["eq", "status", "applied"],
      ["is", "applied_notified_at", null],
    ]);
  });

  it("leaves a failed send unmarked so the next sweep tries again", async () => {
    sendApplied.mockRejectedValueOnce(new Error("Resend is down"));
    admin.results = {
      "bank_detail_changes.select": [{ data: [change()], error: null }],
      "audit_log.select": [{ data: [], error: null }],
    };
    expect(await sendAppliedBankChangeNotices(ORG)).toBe(0);
    expect(marks()).toEqual([]);
  });

  it("does not retry an address the email checks refuse", async () => {
    sendApplied.mockRejectedValueOnce(new z.ZodError([]));
    admin.results = {
      "bank_detail_changes.select": [{ data: [change()], error: null }],
      "audit_log.select": [{ data: [], error: null }],
    };
    await sendAppliedBankChangeNotices(ORG);
    expect(marks()).toHaveLength(1);
  });

  it("gives up on a failing send after the retry window", async () => {
    sendApplied.mockRejectedValueOnce(new Error("Resend is down"));
    const longAgo = new Date(Date.now() - (APPLIED_NOTICE_RETRY_DAYS + 1) * DAY).toISOString();
    admin.results = {
      "bank_detail_changes.select": [
        { data: [change({ applies_after: longAgo, applied_at: longAgo })], error: null },
      ],
      "audit_log.select": [{ data: [], error: null }],
    };
    await sendAppliedBankChangeNotices(ORG);
    expect(marks()).toHaveLength(1);
  });

  it("never logs an address", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    sendApplied.mockRejectedValueOnce(new Error("could not send to musa@example.com"));
    admin.results = {
      "bank_detail_changes.select": [{ data: [change()], error: null }],
      "audit_log.select": [repointed],
    };
    await sendAppliedBankChangeNotices(ORG);
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/@example\.com/);
  });
});
