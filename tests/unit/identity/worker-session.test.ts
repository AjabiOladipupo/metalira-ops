/**
 * The worker session lookup: one embedded read of membership, organisation and worker, the
 * "not a worker" and "unlinked" branches, and which auth call each variant makes. Pages read the
 * user from getClaims (local JWT check); Server Actions keep getUser (asks the Auth server).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/types/db";

const server = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("next/server", () => ({ connection: vi.fn(async () => undefined) }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));
vi.mock("@/lib/supabase/env", () => ({
  getSupabasePublicEnv: () => ({ url: "http://localhost", publishableKey: "pk" }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: vi.fn(async () => server.client),
}));

const {
  lookupWorkerPageSession,
  lookupWorkerSession,
  requireWorkerPageSession,
  resolveWorkerSession,
} = await import("@/server/identity/worker-session");

const USER = "a0000000-0000-4000-8000-000000000001";
const ORG = "b0000000-0000-4000-8000-000000000002";
const WORKER = "c0000000-0000-4000-8000-000000000003";

type Result = { data: unknown; error: unknown };

function fakeClient(result: Result, auth?: { claimsSub?: string | null; userId?: string | null }) {
  const calls = { from: [] as string[], select: [] as string[], eq: [] as unknown[][] };
  const authCalls = { getUser: 0, getClaims: 0 };
  const builder = {
    select(columns: string) {
      calls.select.push(columns);
      return builder;
    },
    eq(column: string, value: unknown) {
      calls.eq.push([column, value]);
      return builder;
    },
    then(resolve: (r: Result) => unknown) {
      return Promise.resolve(result).then(resolve);
    },
  };
  const client = {
    from(table: string) {
      calls.from.push(table);
      return builder;
    },
    auth: {
      async getUser() {
        authCalls.getUser += 1;
        const id = auth?.userId;
        return id
          ? { data: { user: { id } }, error: null }
          : { data: { user: null }, error: new Error("no session") };
      },
      async getClaims() {
        authCalls.getClaims += 1;
        const sub = auth?.claimsSub;
        return sub
          ? { data: { claims: { sub, email: "w@example.test" } }, error: null }
          : { data: null, error: null };
      },
    },
  };
  return { client: client as unknown as SupabaseClient<Database>, calls, authCalls };
}

const linkedRow = {
  organisation_id: ORG,
  worker_id: WORKER,
  organisations: { name: "Coastline Guards", shifts_enabled: true },
  workers: { first_name: "Musa", last_name: "Ibrahim", staff_id: "MO-0001" },
};

describe("resolveWorkerSession", () => {
  it("reads membership, organisation and worker in one embedded query", async () => {
    const { client, calls } = fakeClient({ data: [linkedRow], error: null });
    const lookup = await resolveWorkerSession(client, USER);
    expect(lookup).toEqual({
      type: "worker",
      session: {
        userId: USER,
        workerId: WORKER,
        organisationId: ORG,
        organisationName: "Coastline Guards",
        firstName: "Musa",
        lastName: "Ibrahim",
        staffId: "MO-0001",
        shiftsEnabled: true,
      },
    });
    expect(calls.from).toEqual(["memberships"]);
    expect(calls.select[0]).toContain("workers!memberships_worker_fkey");
    expect(calls.eq).toEqual([
      ["user_id", USER],
      ["role", "worker"],
    ]);
  });

  it("carries the company's Shifts switch (slice 3.0)", async () => {
    const { client, calls } = fakeClient({
      data: [{ ...linkedRow, organisations: { name: "Coastline Guards", shifts_enabled: false } }],
      error: null,
    });
    const lookup = await resolveWorkerSession(client, USER);
    expect(lookup.type === "worker" && lookup.session.shiftsEnabled).toBe(false);
    expect(calls.select[0]).toContain("organisations ( name, shifts_enabled )");
  });

  it("is not a worker when the user has no worker membership", async () => {
    const { client } = fakeClient({ data: [], error: null });
    expect(await resolveWorkerSession(client, USER)).toEqual({ type: "not_worker" });
  });

  it("is unlinked when the membership has no worker record", async () => {
    const { client } = fakeClient({
      data: [{ ...linkedRow, worker_id: null, workers: null }],
      error: null,
    });
    expect(await resolveWorkerSession(client, USER)).toEqual({ type: "unlinked" });
  });

  it("is unlinked when RLS hides the worker row (an ended worker)", async () => {
    const { client } = fakeClient({ data: [{ ...linkedRow, workers: null }], error: null });
    expect(await resolveWorkerSession(client, USER)).toEqual({ type: "unlinked" });
  });

  it("throws on a database error without echoing the message", async () => {
    const { client } = fakeClient({ data: null, error: { code: "42501", message: "secret" } });
    await expect(resolveWorkerSession(client, USER)).rejects.toThrow(
      "Could not load the worker login: 42501",
    );
  });
});

describe("worker session variants", () => {
  beforeEach(() => {
    server.client = null;
  });

  it("the page lookup reads the user from getClaims, never getUser", async () => {
    const fake = fakeClient({ data: [linkedRow], error: null }, { claimsSub: USER });
    server.client = fake.client;
    const lookup = await lookupWorkerPageSession();
    expect(lookup.type).toBe("worker");
    expect(fake.authCalls).toEqual({ getUser: 0, getClaims: 1 });
  });

  it("the verified lookup asks the Auth server with getUser", async () => {
    const fake = fakeClient({ data: [linkedRow], error: null }, { userId: USER });
    server.client = fake.client;
    const lookup = await lookupWorkerSession();
    expect(lookup.type).toBe("worker");
    expect(fake.authCalls).toEqual({ getUser: 1, getClaims: 0 });
  });

  it("the page lookup is signed out without valid claims, and reads no rows", async () => {
    const fake = fakeClient({ data: [linkedRow], error: null }, { claimsSub: null });
    server.client = fake.client;
    expect(await lookupWorkerPageSession()).toEqual({ type: "signed_out" });
    expect(fake.calls.from).toEqual([]);
  });

  it("the page gate sends a signed-out visitor to the worker sign-in", async () => {
    server.client = fakeClient({ data: [], error: null }, { claimsSub: null }).client;
    await expect(requireWorkerPageSession()).rejects.toThrow("redirect:/m/sign-in");
  });
});
