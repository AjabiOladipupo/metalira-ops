import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/types/db";

/**
 * Changing a worker's line manager through "Edit details" tells the new line manager by email,
 * as the mapping panel does (bug fixed 17 Nov 2026: only the mapping panel sent it).
 */

const ORG = "a0000000-0000-4000-8000-000000000001";
const WORKER = "b0000000-0000-4000-8000-000000000002";
const NEW_MANAGER = "b0000000-0000-4000-8000-000000000003";
const OLD_MEMBERSHIP = "c0000000-0000-4000-8000-000000000004";
const DEPT = "d0000000-0000-4000-8000-000000000005";
const ACTOR = "e0000000-0000-4000-8000-000000000006";
const MANAGER_USER = "e0000000-0000-4000-8000-000000000007";

const afterCallbacks: (() => unknown)[] = [];

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({
  after: vi.fn((cb: () => unknown) => {
    afterCallbacks.push(cb);
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));

const sendMappingChangedEmail = vi.fn(async (input: unknown) => {
  void input;
  return { ok: true };
});
vi.mock(import("@/server/email"), async (importOriginal) => ({
  ...(await importOriginal()),
  sendMappingChangedEmail: (input) => sendMappingChangedEmail(input) as never,
}));

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
let contact: { email: string | null; name: string | null; user_id: string | null } | null = null;

/** A client double: reads answer from `tables`, filtered by `in`/`eq`; the update succeeds. */
function fakeClient(): SupabaseClient<Database> {
  function from(table: string) {
    const filters: [string, unknown][] = [];
    const ins: [string, unknown[]][] = [];
    const rows = () =>
      (tables[table] ?? []).filter(
        (row) =>
          filters.every(([c, v]) => !(c in row) || row[c] === v) &&
          ins.every(([c, vs]) => vs.includes(row[c])),
      );
    const builder = {
      select: () => builder,
      update: () => builder,
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return builder;
      },
      neq: () => builder,
      limit: () => builder,
      in(column: string, values: unknown[]) {
        ins.push([column, values]);
        return builder;
      },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
        return Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
      },
    };
    return builder;
  }
  const rpc = vi.fn(async (name: string) =>
    name === "worker_line_manager_contact"
      ? { data: contact ? [contact] : [], error: null }
      : { data: null, error: null },
  );
  return { from, rpc } as unknown as SupabaseClient<Database>;
}

let client: SupabaseClient<Database>;

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: vi.fn(async () => client),
}));
vi.mock("@/server/identity/session", () => ({
  getSession: vi.fn(async () => ({
    user: { id: ACTOR },
    active: { organisationId: ORG, role: "hr" },
  })),
}));

const { updateWorkerAction } = await import("@/server/people/actions");
const { savedMappingFromEdit, mappingNotice } = await import("@/server/people/mapping-notify");

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function save(fields: Record<string, string>) {
  const result = await updateWorkerAction({ ok: true, status: 200 }, form(fields)).catch(
    (e: unknown) => e,
  );
  expect(result).toMatchObject({ message: `redirect:/app/people/${WORKER}` });
  for (const cb of afterCallbacks.splice(0)) await cb();
}

beforeEach(() => {
  afterCallbacks.length = 0;
  sendMappingChangedEmail.mockClear();
  client = fakeClient();
  contact = { email: "tunde@example.com", name: "Tunde Bakare", user_id: null };
  tables.workers = [
    {
      id: WORKER,
      organisation_id: ORG,
      staff_id: "AFS-0042",
      first_name: "Musa",
      last_name: "Ibrahim",
      department_id: DEPT,
      line_manager_worker_id: null,
      line_manager_membership_id: OLD_MEMBERSHIP,
    },
    { id: NEW_MANAGER, organisation_id: ORG, first_name: "Tunde", last_name: "Bakare" },
  ];
  tables.departments = [{ id: DEPT, organisation_id: ORG, name: "Security services" }];
  tables.memberships = [{ id: OLD_MEMBERSHIP, organisation_id: ORG, user_id: MANAGER_USER }];
  tables.profiles = [{ user_id: MANAGER_USER, full_name: "Kola Adebayo" }];
  tables.organisations = [{ id: ORG, name: "Apex Facility Services" }];
});

describe("updateWorkerAction: a new line manager", () => {
  it("emails the new line manager after the response, as the mapping panel does", async () => {
    await save({ workerId: WORKER, firstName: "Musa", lineManager: `w:${NEW_MANAGER}` });

    expect(sendMappingChangedEmail).toHaveBeenCalledTimes(1);
    expect(sendMappingChangedEmail.mock.calls[0]![0]).toMatchObject({
      to: "tunde@example.com",
      workerName: "Musa Ibrahim",
      staffId: "AFS-0042",
      organisationName: "Apex Facility Services",
      managerName: "Tunde Bakare",
      reportsToYou: true,
      changes: ["Line manager: Tunde Bakare (was Kola Adebayo)"],
      appliesFrom: null,
    });
  });

  it("sends nothing when the line manager is unchanged", async () => {
    await save({ workerId: WORKER, firstName: "Musa", lineManager: `m:${OLD_MEMBERSHIP}` });
    expect(sendMappingChangedEmail).not.toHaveBeenCalled();
  });

  it("sends nothing when the line manager is cleared", async () => {
    await save({ workerId: WORKER, firstName: "Musa", lineManager: "" });
    expect(sendMappingChangedEmail).not.toHaveBeenCalled();
  });

  it("sends nothing when the new line manager has no address, or made the change", async () => {
    contact = { email: null, name: "Tunde Bakare", user_id: null };
    await save({ workerId: WORKER, firstName: "Musa", lineManager: `w:${NEW_MANAGER}` });

    tables.workers![0]!.line_manager_worker_id = null;
    contact = { email: "kola@example.com", name: "Kola Adebayo", user_id: ACTOR };
    tables.workers![0]!.line_manager_membership_id = null;
    await save({ workerId: WORKER, firstName: "Musa", lineManager: `m:${OLD_MEMBERSHIP}` });

    expect(sendMappingChangedEmail).not.toHaveBeenCalled();
  });

  it("logs a failed send by worker only, never the address", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    sendMappingChangedEmail.mockRejectedValueOnce(new Error("Resend is down"));
    await save({ workerId: WORKER, firstName: "Musa", lineManager: `w:${NEW_MANAGER}` });
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain(WORKER);
    expect(logged).not.toContain("tunde@example.com");
    error.mockRestore();
  });
});

describe("savedMappingFromEdit", () => {
  it("lists a department change made in the same save", () => {
    const saved = savedMappingFromEdit(
      {
        workerId: WORKER,
        organisationId: ORG,
        actorUserId: ACTOR,
        before: { departmentId: null, lineManager: { workerId: null, membershipId: null } },
        after: { departmentId: DEPT, lineManager: { workerId: NEW_MANAGER, membershipId: null } },
      },
      {
        departments: new Map([[DEPT, "Security services"]]),
        workers: new Map([[NEW_MANAGER, "Tunde Bakare"]]),
        memberships: new Map(),
      },
    );
    expect(mappingNotice(saved, "Tunde Bakare")).toEqual({
      managerName: "Tunde Bakare",
      reportsToYou: true,
      changes: [
        "Department: Security services (was Not set)",
        "Line manager: Tunde Bakare (was Not set)",
      ],
      appliesFrom: null,
    });
  });
});
