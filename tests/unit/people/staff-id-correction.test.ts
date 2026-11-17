/**
 * Slice 1.11 (owner decision 19): staff ID corrections. The database enforces the two-person
 * rule, the work-records rule and the never-used rule (tests/rls/staff-id-corrections.test.ts);
 * these cover the server boundary: input validation, the role list, refusal mapping, and that
 * retired IDs are never offered by the generator or accepted by the import.
 */
import { describe, expect, it } from "vitest";

import { nextStaffId } from "@/server/people/staff-id";
import {
  STAFF_ID_CORRECTORS,
  decideStaffIdCorrectionSchema,
  decideStaffIdCorrectionSpec,
  isStaffIdCorrector,
  requestStaffIdCorrectionSchema,
  requestStaffIdCorrectionSpec,
} from "@/server/people/staff-id-corrections";
import { TEMPLATE_COLUMNS, validateImportTable, type ColumnKey } from "@/server/people/import";
import { runMutation, type MutationContext } from "@/server/identity/mutate";

const WORKER = "b0000000-0000-4000-8000-000000000002";
const ORG = "a0000000-0000-4000-8000-000000000001";

describe("requestStaffIdCorrectionSchema", () => {
  it("accepts a sign-in-safe ID and folds fullwidth characters", () => {
    expect(
      requestStaffIdCorrectionSchema.parse({
        workerId: WORKER,
        newStaffId: " ＡＦＳ-０１４２ ",
        reason: "Typo at import",
      }),
    ).toEqual({ workerId: WORKER, newStaffId: "AFS-0142", reason: "Typo at import" });
  });

  it.each(["", "AFS 0142", "-AFS", "=1+1", "a@b", "<b>", "x".repeat(41), "AFS\n0142"])(
    "refuses %j as a new staff ID",
    (newStaffId) => {
      const result = requestStaffIdCorrectionSchema.safeParse({
        workerId: WORKER,
        newStaffId,
        reason: "Typo at import",
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["newStaffId"]);
    },
  );

  it("needs a reason, in plain text", () => {
    for (const reason of ["", "  ", "ok", "<script>", "x".repeat(501)]) {
      const result = requestStaffIdCorrectionSchema.safeParse({
        workerId: WORKER,
        newStaffId: "AFS-0142",
        reason,
      });
      expect(result.success, reason).toBe(false);
    }
  });

  it("decides with approve or reject only", () => {
    const base = { correctionId: WORKER, note: "" };
    expect(decideStaffIdCorrectionSchema.parse({ ...base, decision: "approve" }).note).toBeNull();
    expect(decideStaffIdCorrectionSchema.safeParse({ ...base, decision: "apply" }).success).toBe(
      false,
    );
  });
});

describe("who corrects staff IDs", () => {
  it("is owner, admin and hr: finance, operations and line managers can't", () => {
    expect([...STAFF_ID_CORRECTORS]).toEqual(["owner", "admin", "hr"]);
    for (const role of ["finance", "ops_manager", "line_manager"] as const) {
      expect(isStaffIdCorrector(role)).toBe(false);
    }
  });

  it("refuses other roles before touching the database", async () => {
    const ctx = (role: MutationContext["role"]): MutationContext => ({
      supabase: {
        from: () => {
          throw new Error("must not reach the database");
        },
      } as unknown as MutationContext["supabase"],
      userId: "u-1",
      organisationId: ORG,
      role,
    });
    const input = { workerId: WORKER, newStaffId: "AFS-0142", reason: "Typo at import" };
    await expect(
      runMutation(ctx("finance"), requestStaffIdCorrectionSpec, input),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      runMutation(ctx("line_manager"), decideStaffIdCorrectionSpec, {
        correctionId: WORKER,
        decision: "approve",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("turns the database's never-used refusal into a field error", async () => {
    const message =
      "Staff ID AFS-0001 has been used before in this company. Choose one nobody has had.";
    const supabase = {
      from: () => ({
        insert: () => ({
          select: () => ({
            single: async () => ({ data: null, error: { code: "MLSI3", message, details: null } }),
          }),
        }),
      }),
    } as unknown as MutationContext["supabase"];
    await expect(
      runMutation(
        { supabase, userId: "u-1", organisationId: ORG, role: "hr" },
        requestStaffIdCorrectionSpec,
        { workerId: WORKER, newStaffId: "AFS-0001", reason: "Typo at import" },
      ),
    ).rejects.toMatchObject({ code: "invalid", fieldErrors: { newStaffId: message } });
  });

  it("explains a refusal because of clock-ins, timesheets or pay", async () => {
    const message =
      "This employee already has clock-ins, timesheets or pay under their staff ID, so it can't be corrected.";
    const supabase = {
      from: () => ({
        update: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  maybeSingle: async () => ({
                    data: null,
                    error: { code: "MLSI6", message, details: null },
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    } as unknown as MutationContext["supabase"];
    await expect(
      runMutation(
        { supabase, userId: "u-2", organisationId: ORG, role: "owner" },
        decideStaffIdCorrectionSpec,
        { correctionId: WORKER, decision: "approve" },
      ),
    ).rejects.toMatchObject({ code: "invalid", message });
  });
});

describe("retired staff IDs are never handed out again", () => {
  it("the generator skips an ID a correction retired", () => {
    // AFS-0003 was corrected to AFS-0004, so AFS-0003 is retired; the next free is AFS-0005.
    expect(nextStaffId(["AFS-0001", "AFS-0002", "AFS-0004", "AFS-0003"])).toBe("AFS-0005");
  });

  const BASE = Object.fromEntries(TEMPLATE_COLUMNS.map((c) => [c, ""])) as Record<
    ColumnKey,
    string
  >;
  const record = (employeeId: string): Record<ColumnKey, string> => ({
    ...BASE,
    employee_id: employeeId,
    first_name: "Kola",
    last_name: "Adebayo",
    phone: "08031110001",
    job_title: "Site supervisor",
    department: "Security services",
    employment_type: "Permanent",
    start_date: "2023-05-02",
    client_company: "Coastline Logistics",
    project: "Coastline guarding contract",
    site: "Apapa Warehouse 3",
    shift_pattern: "Day 06:00-18:00",
    pay_type: "Monthly",
    basic_monthly: "105000",
    tax_state: "Lagos",
    nhf_opt_in: "N",
  });

  function check(employeeId: string, retired: string[]) {
    const table = [[...TEMPLATE_COLUMNS], TEMPLATE_COLUMNS.map((c) => record(employeeId)[c])];
    const result = validateImportTable(table, { retiredStaffIds: retired });
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    return result.rows[0]!;
  }

  it("the import holds back a row that reuses a retired ID", () => {
    const held = check("afs-0003", ["AFS-0003"]);
    expect(held.problems.map((p) => p.code)).toContain("staff_id_retired");
    expect(held.problems.find((p) => p.code === "staff_id_retired")?.message).toBe(
      "Staff ID afs-0003 was used before in your account and can't be given to anyone else.",
    );
  });

  it("the import never generates a retired ID for a blank cell", () => {
    const generated = check("", ["EMP-0001", "EMP-0002"]);
    expect(generated.normalised?.worker.staffId).toBe("EMP-0003");
  });
});
