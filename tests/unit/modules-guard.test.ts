/**
 * Slice 3.0 (security review L1): a change tagged with a module is refused by mutate() when the
 * company has that module off, and every People action carries the `people` tag.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { createInvitesSpec } from "@/server/identity/worker-invites";
import { assertModuleOn, MutationError } from "@/server/identity/mutate";
import * as bankChanges from "@/server/people/bank-changes";
import * as changeRequests from "@/server/people/change-requests";
import * as batches from "@/server/people/imports/batches";
import * as mapping from "@/server/people/mapping";
import * as signIn from "@/server/people/sign-in-status";
import * as staffIds from "@/server/people/staff-id-corrections";
import * as workers from "@/server/people/workers";
import type { Database } from "@/types/db";

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));

function companyRow(row: Record<string, boolean> | null) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  };
  return { from: () => builder } as unknown as SupabaseClient<Database>;
}

const ON = { shifts_enabled: true, people_enabled: true, payroll_enabled: true };

describe("assertModuleOn", () => {
  it("lets a change through when its module is on", async () => {
    await expect(assertModuleOn(companyRow(ON), "org", "people")).resolves.toBeUndefined();
  });

  it("refuses with 'This part is switched off' when its module is off", async () => {
    const off = companyRow({ ...ON, payroll_enabled: false });
    const error = await assertModuleOn(off, "org", "payroll").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MutationError);
    expect(error).toMatchObject({ code: "forbidden" });
    expect((error as Error).message).toMatch(/^This part is switched off\. Payroll is off/);
    await expect(assertModuleOn(off, "org", "people")).resolves.toBeUndefined();
  });

  it("leaves a company row the caller can't read to the change itself", async () => {
    await expect(assertModuleOn(companyRow(null), "org", "shifts")).resolves.toBeUndefined();
  });
});

describe("People actions are tagged with the people module", () => {
  const specs = Object.entries({
    ...bankChanges,
    ...changeRequests,
    ...batches,
    ...mapping,
    ...signIn,
    ...staffIds,
    ...workers,
    createInvitesSpec,
  }).filter(([name]) => name.endsWith("Spec"));

  it("finds them", () => {
    expect(specs.length).toBeGreaterThanOrEqual(20);
  });

  it.each(specs)("%s", (_name, spec) => {
    expect((spec as { module?: string }).module).toBe("people");
  });
});
