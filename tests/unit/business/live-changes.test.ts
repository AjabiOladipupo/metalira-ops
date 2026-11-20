import { describe, expect, it } from "vitest";

import { expandRequiredShifts } from "@/lib/activation";
import {
  formatWeek,
  parseRequirementInput,
  planAddPost,
  planClosePost,
  planRequirementChange,
  weekOf,
  type LiveContract,
  type LivePost,
  type PostSite,
  type PostVersion,
  type RateKeyVersion,
} from "@/lib/live-changes";

const today = "2026-11-20"; // a Friday
const monday = "2026-11-23";

const contract: LiveContract = {
  status: "active",
  type: "manned_post",
  goLiveDate: "2026-11-16",
  endDate: null,
  endReason: null,
};

const night: LivePost = {
  id: "post-night",
  name: "Gate A · Night",
  status: "open",
  openedOn: "2026-11-16",
  closedOn: null,
};

const v1: PostVersion = {
  id: "req-1",
  effectiveFrom: "2026-11-16",
  effectiveTo: null,
  daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
  startTime: "18:00",
  endTime: "06:00",
  requiredCount: 1,
};

const two = { ...v1, requiredCount: 2 };

describe("planRequirementChange", () => {
  it("raising Gate A · Night from 1 to 2 from next Monday closes the current version on Sunday", () => {
    const plan = planRequirementChange({
      contract,
      post: night,
      versions: [v1],
      today,
      from: monday,
      next: two,
    });
    expect(plan).toMatchObject({
      ok: true,
      closes: { id: "req-1", effectiveFrom: "2026-11-16", effectiveToAfter: "2026-11-22" },
      replaces: null,
      starts: { effectiveFrom: monday, effectiveTo: null },
      week: { personShiftsDifference: 7 },
    });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.summary).toBe(
      "Gate A · Night: 1 → 2 people from 23 Nov 2026. 7 → 14 person-shifts (168 h) a week.",
    );

    // Applied, the required shifts show 1 on Sunday and 2 from Monday, and both versions stay.
    const versions: PostVersion[] = [
      { ...v1, effectiveTo: plan.closes!.effectiveToAfter },
      { ...two, id: "req-2", effectiveFrom: monday, effectiveTo: plan.starts.effectiveTo },
    ];
    const shifts = expandRequiredShifts({
      posts: [night],
      requirements: versions.map((v) => ({ ...v, postId: night.id })),
      from: "2026-11-22",
      to: "2026-11-23",
    });
    expect(shifts.map((s) => [s.date, s.requiredCount, s.endsAt])).toEqual([
      ["2026-11-22", 1, "2026-11-23T06:00"],
      ["2026-11-23", 2, "2026-11-24T06:00"],
    ]);
  });

  it("replaces a version that hasn't started when changed from the same day", () => {
    const scheduled: PostVersion = { ...two, id: "req-2", effectiveFrom: monday };
    const plan = planRequirementChange({
      contract,
      post: night,
      versions: [{ ...v1, effectiveTo: "2026-11-22" }, scheduled],
      today,
      from: monday,
      next: { ...v1, requiredCount: 3 },
    });
    expect(plan).toMatchObject({ ok: true, closes: null, replaces: { id: "req-2" } });
  });

  it("refuses with the database's reasons", () => {
    const base = { contract, post: night, versions: [v1], today, next: two };
    expect(planRequirementChange({ ...base, from: "2026-11-19" })).toMatchObject({ code: "MLPC2" });
    expect(planRequirementChange({ ...base, from: monday, next: v1 })).toMatchObject({
      code: "MLPC9",
    });
    expect(
      planRequirementChange({ ...base, versions: [{ ...v1, effectiveFrom: today }], from: today }),
    ).toMatchObject({ code: "MLPC2", reason: expect.stringContaining("Change it from tomorrow") });
    expect(
      planRequirementChange({
        ...base,
        versions: [
          { ...v1, effectiveTo: "2026-11-29" },
          { ...two, id: "r2", effectiveFrom: "2026-11-30" },
        ],
        from: monday,
      }),
    ).toMatchObject({ code: "MLPC3" });
    expect(
      planRequirementChange({ ...base, contract: { ...contract, status: "draft" }, from: monday }),
    ).toMatchObject({ code: "MLPC1" });
    expect(
      planRequirementChange({
        ...base,
        contract: { ...contract, endDate: "2026-11-22" },
        from: monday,
      }),
    ).toMatchObject({ code: "MLPC2" });
    expect(
      planRequirementChange({
        ...base,
        post: { ...night, status: "closed", closedOn: "2026-11-22" },
        from: monday,
      }),
    ).toMatchObject({ code: "MLPC6" });
    expect(
      planRequirementChange({ ...base, from: monday, next: { ...two, startTime: "18:10" } }),
    ).toMatchObject({ code: "MLPC8" });
  });

  it("keeps the new version inside an ending contract", () => {
    const plan = planRequirementChange({
      contract: { ...contract, endDate: "2026-11-30", endReason: "Notice" },
      post: { ...night, status: "closed", closedOn: "2026-11-30" },
      versions: [{ ...v1, effectiveTo: "2026-11-30" }],
      today,
      from: monday,
      next: two,
    });
    expect(plan).toMatchObject({ ok: true, starts: { effectiveTo: "2026-11-30" } });
  });
});

describe("planAddPost", () => {
  const apapa: PostSite = {
    id: "site-a",
    name: "Apapa Warehouse 3",
    onContract: true,
    archived: false,
    hasGeofence: true,
  };
  const rates: RateKeyVersion[] = [
    {
      id: "rc-1",
      effectiveFrom: "2026-11-01",
      effectiveTo: null,
      lines: [
        { role: "Guard", band: "Day", unit: "shift" },
        { role: "Guard", band: "Night", unit: "shift" },
      ],
    },
  ];
  const input = {
    siteId: "site-a",
    postName: "Gate C",
    role: "Guard",
    band: "Night",
    unit: "shift" as const,
    from: monday,
    daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
    startTime: "18:00",
    endTime: "06:00",
    requiredCount: 1,
  };
  const base = { contract, today, input, site: apapa, addSite: false, openPostNames: [], rates };

  it("names the post and gives its week", () => {
    const plan = planAddPost(base);
    expect(plan).toMatchObject({ ok: true, name: "Gate C · Night", siteAdded: false });
    if (!plan.ok) throw new Error(plan.reason);
    expect(formatWeek(plan.week)).toBe("7 person-shifts (84 h) a week");
    expect(plan.summary).toBe(
      "Adds Gate C · Night at Apapa Warehouse 3 from 23 Nov 2026: Every day 18:00–06:00 (next day) × 1.",
    );
  });

  it("needs the rate key on every version from its start, compared as rate keys are", () => {
    expect(
      planAddPost({ ...base, input: { ...input, role: "  GUARD ", band: "night" } }),
    ).toMatchObject({
      ok: true,
    });
    expect(planAddPost({ ...base, input: { ...input, role: "Supervisor" } })).toMatchObject({
      code: "MLPC4",
      reason: "No rate for Supervisor · Night (shift). Add it to the rate card first.",
    });
    const later: RateKeyVersion[] = [
      { ...rates[0]!, effectiveTo: "2026-12-31" },
      {
        id: "rc-2",
        effectiveFrom: "2027-01-01",
        effectiveTo: null,
        lines: [{ role: "Guard", band: "Day", unit: "shift" }],
      },
    ];
    expect(planAddPost({ ...base, rates: later })).toMatchObject({
      code: "MLPC4",
      reason: "No rate for Guard · Night (shift) from 1 Jan 2027. Add it to the rate card first.",
    });
    // A fixed-monthly contract bills an agreed amount: no per-row key needed.
    expect(
      planAddPost({
        ...base,
        contract: { ...contract, type: "fixed_monthly" },
        input: { ...input, role: "Cleaner" },
      }),
    ).toMatchObject({ ok: true });
  });

  it("refuses a duplicate open name and sites that can't take the post", () => {
    expect(planAddPost({ ...base, openPostNames: ["gate  c · night"] })).toMatchObject({
      code: "MLPC8",
    });
    const lekki = { ...apapa, id: "site-l", name: "Lekki Gate", onContract: false };
    expect(planAddPost({ ...base, site: lekki })).toMatchObject({ code: "MLPC5" });
    expect(planAddPost({ ...base, site: lekki, addSite: true })).toMatchObject({
      ok: true,
      siteAdded: true,
    });
    expect(
      planAddPost({ ...base, site: { ...lekki, hasGeofence: false }, addSite: true }),
    ).toMatchObject({
      code: "MLPC5",
      reason: "No geofence at Lekki Gate. Set one on the site first.",
    });
    expect(planAddPost({ ...base, site: { ...apapa, archived: true } })).toMatchObject({
      code: "MLPC5",
    });
  });

  it("closes with an ending contract", () => {
    const plan = planAddPost({
      ...base,
      contract: { ...contract, endDate: "2026-11-30", endReason: "Notice" },
    });
    expect(plan).toMatchObject({ ok: true, closesOn: "2026-11-30" });
  });
});

describe("planClosePost", () => {
  const base = { contract, post: night, today, lastDay: monday, reason: "Gate closed" };

  it("closes on the last day and removes changes scheduled after it", () => {
    const versions = [
      { ...v1, effectiveTo: "2026-11-29" },
      { ...two, id: "req-2", effectiveFrom: "2026-11-30" },
    ];
    const plan = planClosePost({ ...base, versions });
    expect(plan).toMatchObject({
      ok: true,
      cancels: ["req-2"],
      closes: ["req-1"],
      neverStaffed: false,
    });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.summary).toBe(
      "Closes Gate A · Night after 23 Nov 2026 (its last day staffed). 1 scheduled change is removed.",
    );
    expect(plan.week.before).toEqual(weekOf(v1));
  });

  it("closes a post that hasn't opened as never staffed", () => {
    const later = { ...night, openedOn: "2026-11-30" };
    const plan = planClosePost({
      ...base,
      post: later,
      versions: [{ ...v1, effectiveFrom: "2026-11-30" }],
      lastDay: "2026-11-29",
    });
    expect(plan).toMatchObject({ ok: true, neverStaffed: true, cancels: ["req-1"] });
    expect(
      planClosePost({ ...base, post: later, versions: [], lastDay: "2026-11-25" }),
    ).toMatchObject({
      code: "MLPC2",
    });
  });

  it("refuses a past day, no reason, a closed post and a day at the contract's end", () => {
    expect(planClosePost({ ...base, versions: [v1], lastDay: "2026-11-19" })).toMatchObject({
      code: "MLPC2",
    });
    expect(planClosePost({ ...base, versions: [v1], reason: " " })).toMatchObject({
      code: "MLPC7",
    });
    expect(
      planClosePost({
        ...base,
        versions: [v1],
        post: { ...night, status: "closed", closedOn: monday },
      }),
    ).toMatchObject({ code: "MLPC6" });
    expect(
      planClosePost({ ...base, versions: [v1], contract: { ...contract, endDate: monday } }),
    ).toMatchObject({ code: "MLPC2" });
  });
});

describe("parseRequirementInput", () => {
  it("reads typed days, hours and people with the headcount editor's messages", () => {
    expect(
      parseRequirementInput({
        days: ["3", "1", "1"],
        startTime: "06:00",
        endTime: "18:00",
        requiredCount: "2",
      }),
    ).toEqual({
      ok: true,
      values: { daysOfWeek: [1, 3], startTime: "06:00", endTime: "18:00", requiredCount: 2 },
    });
    const bad = parseRequirementInput({
      days: [],
      startTime: "06:10",
      endTime: "18:00",
      requiredCount: "0",
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(Object.keys(bad.errors).sort()).toEqual(["days", "requiredCount", "startTime"]);
  });
});
