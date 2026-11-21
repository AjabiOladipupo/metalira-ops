/**
 * Slice 4.3: the pure rules behind timesheet approval (src/lib/timesheets/approval.ts). The
 * database decides; tests/rls/timesheet-approval.test.ts checks the SQL agrees with these.
 * - Clean lines: pending, nothing to review, informational exceptions only (supervisor, and
 *   no_location / no_selfie when only a supervisor's punch carries them; must-do 2).
 * - Work Units: billable on manned_post and per_visit; made only for a shift day with minutes.
 * - The words the screen and the inbox use: why a day needs review, device against server time.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  blockingExceptions,
  cleanLineIds,
  deviceVsServer,
  distanceText,
  headlineFlag,
  isCleanLine,
  makesWorkUnit,
  reviewReasons,
  workUnitBillable,
  workUnitText,
  type CleanInput,
} from "@/lib/timesheets/approval";
import { describeCleanResult } from "@/server/capabilities/timesheet-previews";
import { adjustedNotice, rejectedNotice } from "@/server/workforce/timesheet-approval";
import { reviewRank } from "@/server/workforce/timesheet-review-data";
import { hasPersonalNumberRun, inboxMessageSchema } from "@/lib/inbox";

const base: CleanInput = {
  status: "pending",
  exceptions: [],
  needsReview: false,
  inPunch: { source: "self", flags: [] },
  outPunch: { source: "self", flags: [] },
};

describe("clean lines", () => {
  it("is pending with nothing to review and no exceptions", () => {
    expect(isCleanLine(base)).toBe(true);
    expect(isCleanLine({ ...base, status: "disputed" })).toBe(false);
    expect(isCleanLine({ ...base, status: "approved" })).toBe(false);
    expect(isCleanLine({ ...base, needsReview: true })).toBe(false);
    for (const e of ["late", "overtime", "no_clock_out", "outside", "corrected", "early_out"]) {
      expect(isCleanLine({ ...base, exceptions: [e] }), e).toBe(false);
    }
  });

  it("treats supervisor as informational, and no_location / no_selfie on supervisor punches", () => {
    const crew: CleanInput = {
      ...base,
      exceptions: ["no_location", "no_selfie", "supervisor"],
      inPunch: { source: "supervisor", flags: ["no_location", "no_selfie"] },
      outPunch: { source: "supervisor", flags: ["no_location"] },
    };
    expect(isCleanLine(crew)).toBe(true);
    expect(isCleanLine({ ...base, exceptions: ["supervisor"] })).toBe(true);
  });

  it("does not excuse the worker's own missing selfie or location", () => {
    const mixed: CleanInput = {
      ...base,
      exceptions: ["no_selfie", "supervisor"],
      inPunch: { source: "self", flags: ["no_selfie"] },
      outPunch: { source: "supervisor", flags: [] },
    };
    expect(isCleanLine(mixed)).toBe(false);
    expect(blockingExceptions(mixed)).toEqual(["no_selfie"]);
    expect(isCleanLine({ ...base, exceptions: ["no_location"] })).toBe(false);
  });

  it("offers only clean, finished days the caller may decide", () => {
    const day = { status: "pending" as const, clean: true, running: false, canDecide: true };
    expect(
      cleanLineIds([
        { id: "a", ...day },
        { id: "b", ...day, running: true },
        { id: "c", ...day, canDecide: false },
        { id: "d", ...day, clean: false },
        { id: "e", ...day, status: "approved" },
      ]),
    ).toEqual(["a"]);
  });
});

describe("Work Units", () => {
  it("are billable on manned_post and per_visit contracts only", () => {
    expect(workUnitBillable("manned_post")).toBe(true);
    expect(workUnitBillable("per_visit")).toBe(true);
    expect(workUnitBillable("fixed_monthly")).toBe(false);
    expect(workUnitBillable("per_job")).toBe(false);
    expect(workUnitBillable(null)).toBe(false);
  });

  it("are made only for a shift day with minutes", () => {
    expect(makesWorkUnit({ hasShift: true, workedMinutes: 720, otMinutes: 0 })).toBe(true);
    expect(makesWorkUnit({ hasShift: true, workedMinutes: 0, otMinutes: 30 })).toBe(true);
    expect(makesWorkUnit({ hasShift: true, workedMinutes: 0, otMinutes: 0 })).toBe(false);
    expect(makesWorkUnit({ hasShift: false, workedMinutes: 480, otMinutes: 0 })).toBe(false);
  });

  it("are described in words on the detail panel", () => {
    const day = {
      hasShift: true,
      workedMinutes: 720,
      otMinutes: 0,
      contractType: "manned_post",
      status: "pending" as const,
      workUnitId: null,
    };
    expect(workUnitText(day)).toBe("Approving makes a billable Work Unit");
    expect(workUnitText({ ...day, contractType: "fixed_monthly" })).toBe(
      "Approving makes a Work Unit, billed with the contract",
    );
    expect(workUnitText({ ...day, hasShift: false })).toBe("No Work Unit: a day with no shift");
  });
});

describe("the words on the screen", () => {
  it("says why a day needs its time checked", () => {
    const recorded = Date.parse("2026-11-18T07:00:00Z");
    const punch = {
      recordedAt: recorded,
      deviceTime: recorded,
      receivedAt: recorded + 3 * 3_600_000,
      timeSource: "elapsed",
    };
    expect(reviewReasons(["delayed"], [punch, null])).toEqual([
      "Sent 3 h after the time it claims",
    ]);
    expect(reviewReasons(["time_unverified"], [punch])).toEqual(["Phone time not checked"]);
    expect(reviewReasons(["late"], [punch])).toEqual([]);
  });

  it("names the first flag that needs a person, informational ones last", () => {
    expect(headlineFlag(["supervisor", "no_clock_out"])).toBe("No clock-out");
    expect(headlineFlag(["supervisor"])).toBe("Clocked in by supervisor");
    expect(headlineFlag([])).toBeNull();
  });

  it("reads the device clock and the distance", () => {
    expect(deviceVsServer(0)).toBe("Matched");
    expect(deviceVsServer(-660)).toBe("11 min behind, corrected");
    expect(deviceVsServer(240)).toBe("4 min ahead, corrected");
    expect(distanceText(620, "outside")).toBe("620 m, outside the site");
    expect(distanceText(null, "unknown")).toBe("Location not known");
  });

  it("sorts disputed, then needs review, then flagged, then clean, then decided", () => {
    const d = (status: "pending" | "approved" | "disputed", extra = {}) => ({
      status,
      clean: false,
      needsReview: false,
      exceptions: [] as string[],
      ...extra,
    });
    expect(reviewRank(d("disputed"))).toBe(0);
    expect(reviewRank(d("pending", { needsReview: true }))).toBe(1);
    expect(reviewRank(d("pending"))).toBe(2);
    expect(reviewRank(d("pending", { clean: true }))).toBe(3);
    expect(reviewRank(d("approved", { exceptions: ["late_punch_after_decision"] }))).toBe(4);
    expect(reviewRank(d("approved"))).toBe(5);
  });
});

describe("notices to the worker", () => {
  it("fit the inbox rules (plain text, no web addresses, no long numbers)", () => {
    const rejected = rejectedNotice("2026-11-18", "Not on site per the gate book");
    expect(inboxMessageSchema.safeParse(rejected).success).toBe(true);
    expect(rejected.title).toBe("Your day on 18 Nov 2026 wasn't approved");
    const adjusted = adjustedNotice("2026-11-18", 720, 20, "Gate book shows 19:20");
    expect(inboxMessageSchema.safeParse(adjusted).success).toBe(true);
    expect(adjusted.body).toContain("12 h worked and 20 min overtime");
    expect(hasPersonalNumberRun(adjusted.body)).toBe(false);
  });
});

describe("the clean preview", () => {
  it("says what is approved and refuses the rest by name", () => {
    const preview = describeCleanResult({
      dryRun: true,
      approved: [
        {
          lineId: "a",
          workerName: "Halima Bello",
          workDate: "2026-11-18",
          workedMinutes: 720,
          otMinutes: 0,
          workUnitId: "u",
          billable: true,
        },
      ],
      refused: [
        {
          lineId: "b",
          code: "flagged",
          workerName: "Chidi Eze",
          workDate: "2026-11-18",
          exceptions: ["no_clock_out"],
        },
        { lineId: "c", code: "not_found", workerName: null, workDate: null, exceptions: [] },
      ],
    });
    expect(preview.summary).toBe(
      "Approves 1 day and makes 1 Work Unit (1 billable); 2 days left for you to decide one by one.",
    );
    expect(preview.changes[1]).toMatchObject({
      label: "Chidi Eze · 18 Nov 2026",
      after: "Not approved: Flagged (No clock-out)",
    });
    expect(preview.changes[2]?.label).toBe("A day you can't see");
  });
});
