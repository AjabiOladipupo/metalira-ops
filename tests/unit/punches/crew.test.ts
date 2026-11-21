import { describe, expect, it } from "vitest";

import {
  CREW_MAX,
  canMark,
  crewEntries,
  crewPayloadSchema,
  crewState,
  isCrewQueueKind,
  photoBlockers,
  toggleAll,
  unmarkedNames,
} from "@/lib/punches/crew";

const NOW = Date.parse("2026-11-21T09:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const id = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;

const members = [
  { workerId: id(1), firstName: "Ngozi", selfieConsent: true, lastKind: null, lastAt: null },
  {
    workerId: id(2),
    firstName: "Halima",
    selfieConsent: false,
    lastKind: "in" as const,
    lastAt: hoursAgo(2),
  },
  {
    workerId: id(3),
    firstName: "Grace",
    selfieConsent: true,
    lastKind: "out" as const,
    lastAt: hoursAgo(1),
  },
  {
    workerId: id(4),
    firstName: "Sani",
    selfieConsent: true,
    lastKind: "in" as const,
    lastAt: hoursAgo(21),
  },
];

describe("crew states", () => {
  it("is present after a clock-in in the last 20 hours, out after a clock-out, else none", () => {
    expect(members.map((m) => crewState(m, NOW))).toEqual(["none", "present", "out", "none"]);
  });

  it("clocks in anyone not clocked in, and clocks out only those who are", () => {
    expect(members.map((m) => canMark(m, "in", NOW))).toEqual([true, false, true, true]);
    expect(members.map((m) => canMark(m, "out", NOW))).toEqual([false, true, false, false]);
  });
});

describe("the checklist", () => {
  it("Select all ticks everyone markable; again clears", () => {
    const all = toggleAll(members, new Set(), "in", NOW);
    expect([...all].sort()).toEqual([id(1), id(3), id(4)]);
    expect(toggleAll(members, all, "in", NOW).size).toBe(0);
    expect([...toggleAll(members, new Set([id(1)]), "out", NOW)]).toEqual([id(2)]);
  });

  it("names the people left unmarked", () => {
    expect(unmarkedNames(members, new Set([id(1)]), "in", NOW)).toEqual(["Grace", "Sani"]);
    expect(unmarkedNames(members, new Set([id(2)]), "out", NOW)).toEqual([]);
  });

  it("offers a group photo only when everyone ticked agreed to photos (rule 9)", () => {
    expect(photoBlockers(members, new Set([id(1), id(3)]))).toEqual([]);
    expect(photoBlockers(members, new Set([id(1), id(2)])).map((m) => m.firstName)).toEqual([
      "Halima",
    ]);
  });

  it("gives each person their own client_event_id", () => {
    let n = 100;
    const entries = crewEntries([id(1), id(3)], () => id(n++));
    expect(entries).toEqual([
      { worker_id: id(1), client_event_id: id(100) },
      { worker_id: id(3), client_event_id: id(101) },
    ]);
  });
});

describe("the queue payload", () => {
  const base = {
    site_id: id(9),
    entries: [{ worker_id: id(1), client_event_id: id(2) }],
    latitude: null,
    longitude: null,
    accuracy_m: null,
    has_photo: false,
  };

  it("takes a valid crew punch", () => {
    expect(crewPayloadSchema.safeParse(base).success).toBe(true);
    expect(isCrewQueueKind("crew_in")).toBe(true);
    expect(isCrewQueueKind("clock_in")).toBe(false);
  });

  it("refuses no one, the same person twice and more than the cap", () => {
    expect(crewPayloadSchema.safeParse({ ...base, entries: [] }).success).toBe(false);
    expect(
      crewPayloadSchema.safeParse({
        ...base,
        entries: [
          { worker_id: id(1), client_event_id: id(2) },
          { worker_id: id(1), client_event_id: id(3) },
        ],
      }).success,
    ).toBe(false);
    const many = Array.from({ length: CREW_MAX + 1 }, (_, i) => ({
      worker_id: id(i + 10),
      client_event_id: id(i + 200),
    }));
    expect(crewPayloadSchema.safeParse({ ...base, entries: many }).success).toBe(false);
  });
});
