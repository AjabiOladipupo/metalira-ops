import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { EMPTY_MAPPING, describeChange, mappingChanges, namesOf } from "@/lib/mapping";
import type { MappingSnapshot } from "@/lib/mapping";
import { MutationError, runMutation, type MutationContext } from "@/server/identity/mutate";
import { mappingFormInput } from "@/server/people/form-input";
import { saveMappingSpec, type SavedMapping } from "@/server/people/mapping";
import { mappingNotice, shouldNotifyLineManager } from "@/server/people/mapping-notify";
import { saveMappingSchema } from "@/server/people/schemas";
import type { Database } from "@/types/db";

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));

const ORG = "a0000000-0000-4000-8000-000000000001";
const WORKER = "b0000000-0000-4000-8000-000000000002";
const MANAGER = "b0000000-0000-4000-8000-000000000003";
const MEMBERSHIP = "c0000000-0000-4000-8000-000000000004";
const DEPT = "d0000000-0000-4000-8000-000000000005";
const SITE_A = "e0000000-0000-4000-8000-000000000006";
const SITE_B = "e0000000-0000-4000-8000-000000000007";
const PROJECT = "f0000000-0000-4000-8000-000000000008";

const before: MappingSnapshot = {
  department: { id: DEPT, name: "Security services" },
  lineManager: { kind: "membership", id: MEMBERSHIP, name: "Kola Adebayo" },
  sites: [{ id: SITE_A, name: "Apapa Warehouse 3" }],
  projects: [{ id: PROJECT, name: "Coastline guarding contract" }],
};

const after: MappingSnapshot = {
  ...before,
  lineManager: { kind: "worker", id: MANAGER, name: "Tunde Bakare" },
  sites: [{ id: SITE_B, name: "Lekki Estate Gate B" }],
};

function dbResult(overrides: Record<string, unknown> = {}) {
  const snap = (s: MappingSnapshot) => ({
    department: s.department,
    line_manager: s.lineManager,
    sites: s.sites,
    projects: s.projects,
  });
  return {
    changed: true,
    department_changed: false,
    line_manager_changed: true,
    assignments_changed: true,
    effective_from: "2026-11-17",
    before: snap(before),
    after: snap(after),
    ...overrides,
  };
}

function fakeSupabase(answer: { data: unknown; error: unknown }) {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    void name;
    void args;
    return answer;
  });
  const client = { rpc } as unknown as SupabaseClient<Database>;
  return { client, rpc };
}

function context(
  client: SupabaseClient<Database>,
  role: MutationContext["role"] = "hr",
): MutationContext {
  return { supabase: client, userId: "user-1", organisationId: ORG, role };
}

describe("mappingChanges", () => {
  it("lists only the fields whose ids changed, in panel order", () => {
    const changes = mappingChanges(before, after);
    expect(changes.map(describeChange)).toEqual([
      "Line manager: Tunde Bakare (was Kola Adebayo)",
      "Site: Lekki Estate Gate B (was Apapa Warehouse 3)",
    ]);
  });

  it("treats a first mapping as changes from Not set and None", () => {
    expect(mappingChanges(EMPTY_MAPPING, before).map(describeChange)).toEqual([
      "Department: Security services (was Not set)",
      "Line manager: Kola Adebayo (was Not set)",
      "Site: Apapa Warehouse 3 (was Not set)",
      "Projects: Coastline guarding contract (was None)",
    ]);
  });

  it("ignores name and order differences when the ids match", () => {
    const reordered: MappingSnapshot = {
      ...before,
      projects: [
        { id: "p2", name: "B" },
        { id: "p1", name: "A" },
      ],
    };
    const same: MappingSnapshot = {
      ...before,
      projects: [
        { id: "p1", name: "A" },
        { id: "p2", name: "B" },
      ],
    };
    expect(mappingChanges(reordered, same)).toEqual([]);
    expect(namesOf(reordered.projects)).toBe("A, B");
    expect(namesOf([])).toBe("None");
  });

  it("names a manager with no profile name generically", () => {
    const unnamed: MappingSnapshot = {
      ...before,
      lineManager: { kind: "membership", id: "other", name: null },
    };
    expect(mappingChanges(before, unnamed).map(describeChange)).toEqual([
      "Line manager: A manager (was Kola Adebayo)",
    ]);
  });
});

describe("mappingFormInput and saveMappingSchema", () => {
  function form(entries: [string, string][]) {
    const data = new FormData();
    for (const [key, value] of entries) data.append(key, value);
    return data;
  }

  it("decodes the line-manager choice and collects every ticked project", () => {
    const input = mappingFormInput(
      form([
        ["workerId", WORKER],
        ["departmentId", DEPT],
        ["lineManager", `w:${MANAGER}`],
        ["siteId", SITE_A],
        ["projectIds", PROJECT],
        ["projectIds", PROJECT],
        ["projectIds", ""],
      ]),
    );
    expect(input).toEqual({
      workerId: WORKER,
      departmentId: DEPT,
      lineManagerWorkerId: MANAGER,
      lineManagerMembershipId: null,
      siteId: SITE_A,
      projectIds: [PROJECT, PROJECT],
    });
    expect(saveMappingSchema.parse(input)).toEqual({
      workerId: WORKER,
      departmentId: DEPT,
      lineManagerWorkerId: MANAGER,
      lineManagerMembershipId: null,
      siteId: SITE_A,
      projectIds: [PROJECT],
    });
  });

  it("clears blank choices", () => {
    const parsed = saveMappingSchema.parse(
      mappingFormInput(
        form([
          ["workerId", WORKER],
          ["departmentId", ""],
          ["lineManager", ""],
          ["siteId", ""],
        ]),
      ),
    );
    expect(parsed).toEqual({
      workerId: WORKER,
      departmentId: null,
      lineManagerWorkerId: null,
      lineManagerMembershipId: null,
      siteId: null,
      projectIds: [],
    });
  });

  it("refuses the worker as their own line manager, both kinds, or bad ids", () => {
    const own = saveMappingSchema.safeParse({ workerId: WORKER, lineManagerWorkerId: WORKER });
    expect(own.success).toBe(false);
    const both = saveMappingSchema.safeParse({
      workerId: WORKER,
      lineManagerWorkerId: MANAGER,
      lineManagerMembershipId: MEMBERSHIP,
    });
    expect(both.success).toBe(false);
    expect(saveMappingSchema.safeParse({ workerId: WORKER, siteId: "site-a" }).success).toBe(false);
    expect(
      saveMappingSchema.safeParse({ workerId: WORKER, projectIds: Array(51).fill(PROJECT) })
        .success,
    ).toBe(false);
  });
});

describe("saveMappingSpec", () => {
  const input = {
    workerId: WORKER,
    departmentId: DEPT,
    lineManagerWorkerId: MANAGER,
    siteId: SITE_B,
    projectIds: [PROJECT],
  };

  it("lets only owner, admin and hr save", async () => {
    for (const role of ["finance", "ops_manager", "line_manager"] as const) {
      const { client, rpc } = fakeSupabase({ data: dbResult(), error: null });
      await expect(
        runMutation(context(client, role), saveMappingSpec, input),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it("calls save_worker_mapping for the active organisation and audits before and after", async () => {
    const { client, rpc } = fakeSupabase({ data: dbResult(), error: null });
    rpc.mockImplementation(async (name: string) =>
      name === "log_audit" ? { data: "audit-id", error: null } : { data: dbResult(), error: null },
    );
    const saved = await runMutation(context(client), saveMappingSpec, input);

    expect(rpc).toHaveBeenNthCalledWith(1, "save_worker_mapping", {
      p_organisation_id: ORG,
      p_worker_id: WORKER,
      p_department_id: DEPT,
      p_line_manager_worker_id: MANAGER,
      p_line_manager_membership_id: undefined,
      p_site_id: SITE_B,
      p_project_ids: [PROJECT],
    });
    expect(saved).toMatchObject({
      workerId: WORKER,
      organisationId: ORG,
      actorUserId: "user-1",
      changed: true,
      lineManagerChanged: true,
      assignmentsChanged: true,
      effectiveFrom: "2026-11-17",
      before,
      after,
    });

    const audit = rpc.mock.calls.find(([name]) => name === "log_audit")?.[1];
    expect(audit).toMatchObject({
      p_organisation_id: ORG,
      p_action: "people.mapping_saved",
      p_entity: "workers",
      p_entity_id: WORKER,
      p_before: { sites: [{ id: SITE_A, name: "Apapa Warehouse 3" }] },
      p_after: {
        sites: [{ id: SITE_B, name: "Lekki Estate Gate B" }],
        lineManager: { kind: "worker", id: MANAGER, name: "Tunde Bakare" },
        assignmentsFrom: "2026-11-17",
      },
    });
  });

  it("writes no audit event when nothing changed", async () => {
    const { client, rpc } = fakeSupabase({
      data: dbResult({
        changed: false,
        line_manager_changed: false,
        assignments_changed: false,
        after: dbResult().before,
      }),
      error: null,
    });
    const saved = await runMutation(context(client), saveMappingSpec, input);
    expect(saved.changed).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("turns the database's refusals into field errors", async () => {
    const cases: [string, string, string][] = [
      [
        "MLLM1",
        "That line manager reports to this worker, which would make a loop.",
        "lineManagerWorkerId",
      ],
      ["MLLM2", "The line manager must be a manager in this company.", "lineManagerMembershipId"],
      ["MLAS4", "That site wasn't found.", "siteId"],
      ["MLAS5", "That project wasn't found.", "projectIds"],
    ];
    for (const [code, message, field] of cases) {
      const { client } = fakeSupabase({ data: null, error: { code, message, details: null } });
      const error = await runMutation(context(client), saveMappingSpec, input).catch((e) => e);
      expect(error).toBeInstanceOf(MutationError);
      expect(error).toMatchObject({ code: "invalid", fieldErrors: { [field]: message } });
    }
    const { client } = fakeSupabase({
      data: null,
      error: { code: "P0002", message: "That employee wasn't found.", details: null },
    });
    await expect(runMutation(context(client), saveMappingSpec, input)).rejects.toMatchObject({
      code: "invalid",
      message: "That employee wasn't found.",
    });
  });
});

describe("line manager notice", () => {
  const saved: SavedMapping = {
    workerId: WORKER,
    organisationId: ORG,
    actorUserId: "user-1",
    changed: true,
    lineManagerChanged: true,
    assignmentsChanged: true,
    effectiveFrom: "2026-11-17",
    before,
    after,
  };

  it("tells the line manager only when something changed and there is one", () => {
    expect(shouldNotifyLineManager(saved)).toBe(true);
    expect(shouldNotifyLineManager({ ...saved, changed: false })).toBe(false);
    expect(shouldNotifyLineManager({ ...saved, after: { ...after, lineManager: null } })).toBe(
      false,
    );
  });

  it("says what changed and from when", () => {
    expect(mappingNotice(saved, "Tunde Bakare")).toEqual({
      managerName: "Tunde Bakare",
      reportsToYou: true,
      changes: [
        "Line manager: Tunde Bakare (was Kola Adebayo)",
        "Site: Lekki Estate Gate B (was Apapa Warehouse 3)",
      ],
      appliesFrom: "17 Nov 2026",
    });
    expect(
      mappingNotice({ ...saved, assignmentsChanged: false, lineManagerChanged: false }, null),
    ).toMatchObject({ reportsToYou: false, appliesFrom: null, managerName: null });
  });

  it("drops names that could carry a link or markup", () => {
    const sneaky: SavedMapping = {
      ...saved,
      before: {
        ...before,
        lineManager: { kind: "membership", id: MEMBERSHIP, name: "Visit www.evil.test" },
      },
    };
    const notice = mappingNotice(sneaky, "<b>Kola</b>");
    expect(notice.managerName).toBeNull();
    expect(notice.changes[0]).toBe("Line manager: Tunde Bakare (was A manager)");
  });
});
