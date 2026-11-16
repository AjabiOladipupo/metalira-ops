import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { MutationError, runMutation, type MutationContext } from "@/server/identity/mutate";
import { createDepartmentSpec, updateDepartmentSpec } from "@/server/people/departments";
import type { Database } from "@/types/db";

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));

const ORG = "a0000000-0000-4000-8000-000000000001";
const DEPT = "d0000000-0000-4000-8000-000000000004";
const HEAD = "b0000000-0000-4000-8000-000000000002";

type Result = { data: unknown; error: unknown };

/** Records the insert or update and its filters; answers with `result`. */
function fakeSupabase(result: Result) {
  const calls: { op: string; payload: unknown; filters: unknown[][] }[] = [];
  function from(table: string) {
    const call = { op: "", payload: null as unknown, filters: [] as unknown[][], table };
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

function context(
  client: SupabaseClient<Database>,
  role: MutationContext["role"] = "hr",
): MutationContext {
  return { supabase: client, userId: "user-1", organisationId: ORG, role };
}

describe("createDepartment", () => {
  it("adds a department in the active organisation, with its head", async () => {
    const fake = fakeSupabase({ data: { id: DEPT }, error: null });
    const result = await runMutation(context(fake.client), createDepartmentSpec, {
      name: "  Security services ",
      headWorkerId: HEAD,
    });
    expect(result).toEqual({ id: DEPT });
    expect(fake.calls[0]).toMatchObject({
      op: "insert",
      payload: { organisation_id: ORG, name: "Security services", head_worker_id: HEAD },
    });
  });

  it("treats a blank head as none", async () => {
    const fake = fakeSupabase({ data: { id: DEPT }, error: null });
    await runMutation(context(fake.client, "owner"), createDepartmentSpec, {
      name: "Head office",
      headWorkerId: "",
    });
    expect(fake.calls[0]?.payload).toMatchObject({ head_worker_id: null });
  });

  it("refuses roles that can't change people, before touching the database", async () => {
    for (const role of ["finance", "ops_manager", "line_manager"] as const) {
      const fake = fakeSupabase({ data: { id: DEPT }, error: null });
      await expect(
        runMutation(context(fake.client, role), createDepartmentSpec, { name: "Cleaning" }),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(fake.calls).toHaveLength(0);
    }
  });

  it("refuses names with markup or a web address", async () => {
    const fake = fakeSupabase({ data: { id: DEPT }, error: null });
    for (const name of ["", "<b>Ops</b>", "www.example.com"]) {
      await expect(
        runMutation(context(fake.client), createDepartmentSpec, { name }),
      ).rejects.toMatchObject({ code: "invalid" });
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("explains a duplicate name on the name field", async () => {
    const fake = fakeSupabase({
      data: null,
      error: {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "departments_organisation_name_key"',
      },
    });
    const error = await runMutation(context(fake.client), createDepartmentSpec, {
      name: "Security services",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MutationError);
    expect((error as MutationError).fieldErrors.name).toBe(
      "A department with this name already exists.",
    );
  });
});

describe("updateDepartment", () => {
  it("renames and sets the head, scoped to the active organisation", async () => {
    const fake = fakeSupabase({ data: { id: DEPT }, error: null });
    await runMutation(context(fake.client), updateDepartmentSpec, {
      departmentId: DEPT,
      name: "Guarding",
      headWorkerId: HEAD,
    });
    expect(fake.calls[0]).toMatchObject({
      op: "update",
      payload: { name: "Guarding", head_worker_id: HEAD },
      filters: [
        ["id", DEPT],
        ["organisation_id", ORG],
      ],
    });
  });

  it("clears the head when it is left blank", async () => {
    const fake = fakeSupabase({ data: { id: DEPT }, error: null });
    await runMutation(context(fake.client), updateDepartmentSpec, {
      departmentId: DEPT,
      name: "Guarding",
      headWorkerId: "",
    });
    expect(fake.calls[0]?.payload).toEqual({ name: "Guarding", head_worker_id: null });
  });

  it("says so when the department isn't visible", async () => {
    const fake = fakeSupabase({ data: null, error: null });
    await expect(
      runMutation(context(fake.client), updateDepartmentSpec, {
        departmentId: DEPT,
        name: "Guarding",
      }),
    ).rejects.toMatchObject({ code: "invalid", message: "That department wasn't found." });
  });
});
