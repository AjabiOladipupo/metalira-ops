/**
 * Slice U.2: the skip-reason logic of the lists' bulk actions, and the selection guard. Skipping
 * is not failing: the preview says "N will be approved, M skipped" with each reason, the codes map
 * to plain words (unknown codes fall back safely), and a confirm only acts on the preview's set.
 */
import { describe, expect, it } from "vitest";

import {
  INVITE_SKIP_TEXT,
  LEAVE_SKIP_TEXT,
  TIMESHEET_SKIP_TEXT,
  bulkSummary,
  inviteSkipCode,
  leaveSkipCode,
  leaveSkipReason,
} from "@/lib/bulk-approve";
import {
  LIST_CHANGED,
  ListChanged,
  NotInList,
  confirmSelection,
  idSet,
  previewedSet,
  resolveSelection,
} from "@/server/identity/bulk-selection";
import { parseBulkLeave } from "@/server/people/leave-bulk";

const A = "a0000000-0000-4000-8000-000000000001";
const B = "b0000000-0000-4000-8000-000000000002";
const C = "c0000000-0000-4000-8000-000000000003";

describe("bulkSummary", () => {
  it("says how many go ahead, and groups the skipped by reason, most common first", () => {
    expect(
      bulkSummary(3, [LEAVE_SKIP_TEXT.own, LEAVE_SKIP_TEXT.not_yours, LEAVE_SKIP_TEXT.not_yours]),
    ).toBe("3 will be approved, 3 skipped: 2 not yours to decide; 1 your own leave.");
  });

  it("has no skipped part when nothing is skipped, and words the result once done", () => {
    expect(bulkSummary(2, [])).toBe("2 will be approved.");
    expect(bulkSummary(1, [TIMESHEET_SKIP_TEXT.flagged], { verb: "approved", done: true })).toBe(
      "1 approved, 1 skipped: 1 flagged: open the day to decide.",
    );
    expect(bulkSummary(0, [INVITE_SKIP_TEXT.cap], { verb: "emailed" })).toMatch(
      /^0 will be emailed, 1 skipped: 1 today's email limit is reached/,
    );
  });
});

describe("leave skip reasons", () => {
  it("maps every code the database returns to words", () => {
    for (const code of [
      "own",
      "not_yours",
      "decided",
      "certificate",
      "recount",
      "pay_below_service",
      "refused",
    ] as const) {
      expect(leaveSkipCode(code)).toBe(code);
      expect(leaveSkipReason(code, null)).toBe(LEAVE_SKIP_TEXT[code]);
    }
  });

  it("treats an unknown code as refused, never as approved", () => {
    expect(leaveSkipCode("something_new")).toBe("refused");
    expect(leaveSkipCode(null)).toBe("refused");
  });

  it("shows the single decision's own words when it refused, and the count for a recount", () => {
    expect(
      leaveSkipReason("refused", "The worker has 2 days left, fewer than the 3 asked for."),
    ).toBe("The worker has 2 days left, fewer than the 3 asked for.");
    expect(leaveSkipReason("recount", "Now 4 working days; the request says 5.")).toBe(
      `${LEAVE_SKIP_TEXT.recount}. Now 4 working days; the request says 5.`,
    );
    // Only refused and recount carry the database's detail.
    expect(leaveSkipReason("own", "anything")).toBe(LEAVE_SKIP_TEXT.own);
  });

  it("parses the database's answer into approved and skipped", () => {
    const parsed = parseBulkLeave({
      dry_run: true,
      approved: [
        {
          id: A,
          worker_id: B,
          worker_name: "Ada Obi",
          staff_id: "EMP-1",
          leave_type: "Annual",
          start_date: "2026-12-01",
          end_date: "2026-12-05",
          step: "hr",
          status: "approved",
          days: 5,
          balance_after: 10,
          opened_shifts: 2,
        },
      ],
      skipped: [
        {
          id: C,
          code: "certificate",
          reason: null,
          worker_name: null,
          staff_id: null,
          leave_type: "Sick",
          start_date: "2026-12-02",
          end_date: "2026-12-02",
        },
      ],
    });
    expect(parsed.approved[0]).toMatchObject({
      id: A,
      step: "hr",
      balanceAfter: 10,
      openedShifts: 2,
    });
    expect(parsed.skipped[0]).toMatchObject({
      id: C,
      code: "certificate",
      reason: LEAVE_SKIP_TEXT.certificate,
      workerName: null,
    });
  });
});

describe("timesheet and invite skip reasons", () => {
  it("words every refusal approve_clean_timesheet_lines returns", () => {
    for (const code of [
      "not_found",
      "own",
      "not_yours",
      "decided",
      "disputed",
      "running",
      "needs_review",
      "flagged",
    ] as const) {
      expect(TIMESHEET_SKIP_TEXT[code]).toMatch(/^[A-Z]/);
    }
  });

  it("knows every invite code and drops unknown ones", () => {
    for (const code of Object.keys(INVITE_SKIP_TEXT)) expect(inviteSkipCode(code)).toBe(code);
    expect(inviteSkipCode("nope")).toBeNull();
  });
});

describe("the selection guard", () => {
  const visible = idSet([A, B]);

  it("resolves ticked ids the caller can read, distinct", () => {
    expect(resolveSelection([A, B, A.toUpperCase()], visible)).toEqual([A, B]);
  });

  it("refuses an id the caller can't read (another company's or out of scope)", () => {
    expect(() => resolveSelection([A, C], visible)).toThrow(NotInList);
  });

  it("confirms only the preview's set, whatever the order", () => {
    const preview = previewedSet([A, B]);
    expect(preview.count).toBe(2);
    expect(confirmSelection([B, A], visible, preview.digest).sort()).toEqual([A, B]);
  });

  it("refuses with 'the list changed' when the set differs or a row is gone", () => {
    const preview = previewedSet([A, B]);
    expect(() => confirmSelection([A], visible, preview.digest)).toThrow(ListChanged);
    expect(() => confirmSelection([A, B], idSet([A]), preview.digest)).toThrow(LIST_CHANGED);
  });
});
