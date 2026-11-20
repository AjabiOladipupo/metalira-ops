/**
 * Slice 2.7: the pure activation library (src/lib/activation.ts): the checklist and preview
 * before "Activate contract", a database refusal turned back into its list, the expansion of
 * roster requirements into required shifts (a night shift across midnight, a Mon–Fri post, dates
 * outside the post and the contract), and the "End contract" preview.
 */
import { describe, expect, it } from "vitest";

import {
  activationIssuesFromDb,
  datesBetween,
  defaultGoLiveDate,
  expandRequiredShifts,
  planActivation,
  planEndContract,
  summariseRequiredShifts,
  type ActivationInput,
  type RosterPost,
  type RosterRequirement,
} from "@/lib/activation";
import type { HeadcountLine } from "@/lib/headcount";
import type { RateCardVersion, RateLine } from "@/lib/rate-cards";

const APAPA = "00000000-0000-4000-8000-0000000000a1";
const GATE_B = "00000000-0000-4000-8000-0000000000b2";
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

const rate = (over: Partial<RateLine>): RateLine => ({
  role: "Guard",
  band: "Day",
  unit: "shift",
  rateKobo: 1_250_000n,
  currency: "NGN",
  otRateKobo: null,
  otMultiplierBps: null,
  serviceType: "services",
  whtRateBps: 200,
  ...over,
});

const card: RateCardVersion = {
  id: "v1",
  effectiveFrom: "2026-12-01",
  effectiveTo: null,
  note: null,
  lines: [rate({}), rate({ band: "Night", rateKobo: 1_500_000n })],
};

const row = (over: Partial<HeadcountLine>): HeadcountLine => ({
  id: "h1",
  siteId: APAPA,
  postName: "Gate A",
  role: "Guard",
  band: "Day",
  unit: "shift",
  daysOfWeek: EVERY_DAY,
  startTime: "06:00",
  endTime: "18:00",
  requiredCount: 1,
  notes: null,
  ...over,
});

const coastline: HeadcountLine[] = [
  row({ id: "h1" }),
  row({ id: "h2", band: "Night", startTime: "18:00", endTime: "06:00" }),
  row({
    id: "h3",
    siteId: GATE_B,
    postName: "Patrol",
    band: "Night",
    startTime: "18:00",
    endTime: "06:00",
  }),
  row({ id: "h4", siteId: GATE_B, postName: "Warehouse floor" }),
];

function input(over: Partial<ActivationInput> = {}): ActivationInput {
  return {
    contract: { status: "draft", type: "manned_post", startDate: "2026-12-01", endDate: null },
    today: "2026-11-20",
    clientArchived: false,
    hasBillingContact: true,
    sites: [
      { id: APAPA, name: "Apapa Warehouse 3", archived: false, hasGeofence: true },
      { id: GATE_B, name: "Gate B", archived: false, hasGeofence: true },
    ],
    versions: [card],
    headcount: coastline,
    ...over,
  };
}

describe("planActivation", () => {
  it("is ready for the Coastline contract and says what it creates", () => {
    const plan = planActivation(input());
    expect(plan.ready).toBe(true);
    expect(plan.issues).toEqual([]);
    expect(plan.goLiveDate).toBe("2026-12-01");
    expect(plan.summary).toBe("Creates 4 posts and 4 roster requirements from 1 Dec 2026.");
    expect(plan.posts.map((p) => `${p.name} at ${p.siteName}`)).toEqual([
      "Gate A · Day at Apapa Warehouse 3",
      "Gate A · Night at Apapa Warehouse 3",
      "Patrol · Night at Gate B",
      "Warehouse floor · Day at Gate B",
    ]);
    expect(plan.posts[1]).toMatchObject({ days: "Every day", hours: "18:00–06:00 (next day)" });
    expect(plan.checks.every((c) => c.ok)).toBe(true);
    expect(plan.checks.map((c) => c.code)).not.toContain("MLCT1");
  });

  it("goes live today when the contract started earlier", () => {
    expect(defaultGoLiveDate("2026-11-01", "2026-11-20")).toBe("2026-11-20");
    const plan = planActivation(
      input({
        contract: { status: "draft", type: "manned_post", startDate: "2026-11-01", endDate: null },
        versions: [{ ...card, effectiveFrom: "2026-11-01" }],
      }),
    );
    expect(plan.goLiveDate).toBe("2026-11-20");
    expect(plan.ready).toBe(true);
  });

  it("lists everything missing at once, in plain English", () => {
    const plan = planActivation(
      input({
        hasBillingContact: false,
        clientArchived: true,
        sites: [
          { id: APAPA, name: "Apapa Warehouse 3", archived: true, hasGeofence: false },
          { id: GATE_B, name: "Gate B", archived: false, hasGeofence: false },
        ],
        headcount: [...coastline, row({ id: "h5", band: "Supervisor" })],
      }),
    );
    expect(plan.ready).toBe(false);
    expect(plan.issues).toEqual([
      {
        code: "MLCT2",
        message: "The client has no billing contact. Add one with an email address.",
      },
      { code: "MLCT8", message: "The client is archived. Restore it first." },
      {
        code: "MLCT8",
        message: "Archived sites: Apapa Warehouse 3. Restore them or take them off the contract.",
      },
      {
        code: "MLCT3",
        message: "No geofence at Apapa Warehouse 3, Gate B. Set one on each site.",
      },
      {
        code: "MLCT5",
        message: "No rate for Guard · Supervisor (shift). Add it to the rate card.",
      },
    ]);
    const geofence = plan.checks.find((c) => c.code === "MLCT3");
    expect(geofence).toMatchObject({ ok: false, label: "Sites with a geofence" });
  });

  it("needs a rate card in force on the go-live date, headcount and sensible dates", () => {
    const plan = planActivation(input({ versions: [], headcount: [], goLiveDate: "2026-11-25" }));
    expect(plan.issues.map((i) => i.code)).toEqual(["MLCT7", "MLCT4", "MLCT6"]);
    expect(plan.issues[0]!.message).toBe("The go-live date is before the contract starts.");
    expect(plan.issues[1]!.message).toBe("No rate card is in force on 25 Nov 2026.");

    const ends = planActivation(
      input({
        contract: {
          status: "draft",
          type: "manned_post",
          startDate: "2026-12-01",
          endDate: "2026-12-31",
        },
        goLiveDate: "2027-01-05",
      }),
    );
    expect(ends.issues.map((i) => i.message)).toContain(
      "The contract ends before the go-live date.",
    );

    const past = planActivation(input({ goLiveDate: "2026-11-19", today: "2026-11-20" }));
    expect(past.issues.map((i) => i.message)).toContain("The go-live date is in the past.");
  });

  it("checks every rate card version from the go-live date, not only the first", () => {
    const later: RateCardVersion = {
      id: "v2",
      effectiveFrom: "2027-01-01",
      effectiveTo: null,
      note: null,
      lines: [rate({ rateKobo: 1_300_000n })],
    };
    const plan = planActivation(
      input({ versions: [{ ...card, effectiveTo: "2026-12-31" }, later] }),
    );
    expect(plan.issues).toEqual([
      {
        code: "MLCT5",
        message: "No rate for Guard · Night (shift) from 1 Jan 2027. Add it to the rate card.",
      },
    ]);
    // A version that ends before go-live doesn't count.
    const before = planActivation(
      input({
        contract: { status: "draft", type: "manned_post", startDate: "2026-11-01", endDate: null },
        today: "2027-01-05",
        versions: [
          { ...card, effectiveFrom: "2026-11-01", effectiveTo: "2026-12-31", lines: [rate({})] },
          { ...later, lines: card.lines },
        ],
      }),
    );
    expect(before.ready).toBe(true);
  });

  it("doesn't price headcount on fixed-monthly contracts, nor require it", () => {
    const plan = planActivation(
      input({
        contract: {
          status: "draft",
          type: "fixed_monthly",
          startDate: "2026-12-01",
          endDate: null,
        },
        versions: [
          {
            ...card,
            lines: [rate({ role: "Facility management", band: "standard", unit: "month" })],
          },
        ],
        headcount: [row({ band: "Supervisor" })],
      }),
    );
    expect(plan.ready).toBe(true);
    const none = planActivation(
      input({
        contract: { status: "draft", type: "per_job", startDate: "2026-12-01", endDate: null },
        headcount: [],
      }),
    );
    expect(none.ready).toBe(true);
    expect(none.summary).toBe("Creates 0 posts and 0 roster requirements from 1 Dec 2026.");
  });

  it("refuses an ended contract and says a live one is live", () => {
    const ended = planActivation(
      input({
        contract: { status: "ended", type: "manned_post", startDate: "2026-12-01", endDate: null },
      }),
    );
    expect(ended.ready).toBe(false);
    expect(ended.checks[0]).toMatchObject({ code: "MLCT1", ok: false });
    const live = planActivation(
      input({
        contract: { status: "active", type: "manned_post", startDate: "2026-12-01", endDate: null },
      }),
    );
    expect(live.ready).toBe(false);
    expect(live.summary).toBe("This contract is live.");
  });
});

describe("activationIssuesFromDb", () => {
  it("reads every item from the refusal's detail", () => {
    const details = JSON.stringify([
      {
        code: "MLCT2",
        message: "The client has no billing contact. Add one with an email address.",
      },
      { code: "MLCT3", message: "No geofence at Gate B. Set one on each site." },
    ]);
    expect(activationIssuesFromDb({ code: "MLCT2", message: "x", details })).toEqual([
      {
        code: "MLCT2",
        message: "The client has no billing contact. Add one with an email address.",
      },
      { code: "MLCT3", message: "No geofence at Gate B. Set one on each site." },
    ]);
  });

  it("falls back to the message, and ignores anything that isn't a known item", () => {
    expect(
      activationIssuesFromDb({ code: "MLCT6", message: "Needs headcount.", details: null }),
    ).toEqual([{ code: "MLCT6", message: "Needs headcount." }]);
    expect(
      activationIssuesFromDb({
        code: "MLCT4",
        message: "No card.",
        details: JSON.stringify([{ code: "DROP", message: "x" }, "junk"]),
      }),
    ).toEqual([{ code: "MLCT4", message: "No card." }]);
    expect(activationIssuesFromDb({ code: "23505", message: "dup" })).toEqual([]);
  });
});

describe("expandRequiredShifts", () => {
  const posts: RosterPost[] = [
    { id: "p-day", name: "Gate A · Day", openedOn: "2026-11-23", closedOn: null },
    { id: "p-night", name: "Gate A · Night", openedOn: "2026-11-23", closedOn: null },
    { id: "p-office", name: "Reception", openedOn: "2026-11-23", closedOn: "2026-11-26" },
  ];
  const requirements: RosterRequirement[] = [
    {
      id: "r-day",
      postId: "p-day",
      effectiveFrom: "2026-11-23",
      effectiveTo: null,
      daysOfWeek: EVERY_DAY,
      startTime: "06:00",
      endTime: "18:00",
      requiredCount: 2,
    },
    {
      id: "r-night",
      postId: "p-night",
      effectiveFrom: "2026-11-23",
      effectiveTo: null,
      daysOfWeek: EVERY_DAY,
      startTime: "18:00:00",
      endTime: "06:00:00",
      requiredCount: 1,
    },
    {
      id: "r-office",
      postId: "p-office",
      effectiveFrom: "2026-11-23",
      effectiveTo: null,
      daysOfWeek: [1, 2, 3, 4, 5],
      startTime: "08:00",
      endTime: "17:00",
      requiredCount: 1,
    },
  ];

  it("gives one shift per post and day; a night shift belongs to the day it starts", () => {
    // Mon 23 Nov to Sun 29 Nov 2026.
    const shifts = expandRequiredShifts({
      posts,
      requirements,
      from: "2026-11-23",
      to: "2026-11-29",
    });
    const night = shifts.filter((s) => s.postId === "p-night");
    expect(night).toHaveLength(7);
    expect(night[0]).toMatchObject({
      date: "2026-11-23",
      startsAt: "2026-11-23T18:00",
      endsAt: "2026-11-24T06:00",
      requiredCount: 1,
    });
    expect(night[6]).toMatchObject({ startsAt: "2026-11-29T18:00", endsAt: "2026-11-30T06:00" });
    expect(shifts.filter((s) => s.postId === "p-day")).toHaveLength(7);
    // Mon–Fri, but the post closes after Thursday.
    expect(shifts.filter((s) => s.postId === "p-office").map((s) => s.date)).toEqual([
      "2026-11-23",
      "2026-11-24",
      "2026-11-25",
      "2026-11-26",
    ]);
    expect(summariseRequiredShifts(shifts)).toEqual({
      shifts: 18,
      personShifts: 14 + 7 + 4,
      personMinutes: 14 * 720 + 7 * 720 + 4 * 540,
    });
  });

  it("leaves out days before the post opens, outside a requirement, and outside the contract", () => {
    const shifts = expandRequiredShifts({
      posts,
      requirements: [
        { ...requirements[0]!, effectiveTo: "2026-11-24" },
        { ...requirements[0]!, id: "r-day-2", effectiveFrom: "2026-11-25", requiredCount: 3 },
      ],
      from: "2026-11-21",
      to: "2026-11-27",
      contract: { goLiveDate: "2026-11-23", endDate: "2026-11-26" },
    });
    expect(shifts.map((s) => `${s.date}:${s.requiredCount}`)).toEqual([
      "2026-11-23:2",
      "2026-11-24:2",
      "2026-11-25:3",
      "2026-11-26:3",
    ]);
  });

  it("caps the range at 62 days and refuses a backwards one", () => {
    expect(datesBetween("2026-12-30", "2027-01-02")).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
    expect(() =>
      expandRequiredShifts({ posts, requirements, from: "2026-11-23", to: "2027-01-24" }),
    ).toThrow("62 days");
    expect(() =>
      expandRequiredShifts({ posts, requirements, from: "2026-11-23", to: "2026-11-22" }),
    ).toThrow();
  });
});

describe("planEndContract", () => {
  const base = {
    status: "active" as const,
    goLiveDate: "2026-12-01",
    endDate: null,
    endReason: null,
    today: "2026-12-10",
    endOn: "2026-12-31",
    openPosts: 4,
  };

  it("says what closes", () => {
    expect(planEndContract(base)).toEqual({
      ok: true,
      summary:
        "Closes 4 posts, their roster requirements and the rate card on 31 Dec 2026. The contract ends after that day.",
    });
  });

  it("refuses a past day, a day before go-live, a later end and a second ending", () => {
    expect(planEndContract({ ...base, endOn: "2026-12-09" })).toMatchObject({ ok: false });
    expect(planEndContract({ ...base, today: "2026-11-20", endOn: "2026-11-30" })).toEqual({
      ok: false,
      reason: "The last day of service can't be before the go-live date.",
    });
    expect(planEndContract({ ...base, endDate: "2026-12-20" })).toMatchObject({ ok: false });
    expect(planEndContract({ ...base, endDate: "2026-12-31", endReason: "Notice" })).toMatchObject({
      ok: true,
    });
    expect(planEndContract({ ...base, endDate: "2026-12-20", endReason: "Notice" })).toMatchObject({
      ok: false,
    });
    expect(planEndContract({ ...base, status: "draft" })).toMatchObject({ ok: false });
  });
});
