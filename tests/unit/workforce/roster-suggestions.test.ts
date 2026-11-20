/**
 * Slice 3.2: who could cover an uncovered shift (src/lib/roster-suggestions.ts). Mapped to the
 * site first, then the relief pool, then people mapped elsewhere; leavers, people who haven't
 * started, people on leave (Phase 4 hook) and double-booked people are never suggested; hours
 * against the weekly standard are flags, never blocks.
 */
import { describe, expect, it } from "vitest";

import {
  NEAR_STANDARD_MINUTES,
  matchesSearch,
  noLeave,
  rankCandidates,
  topSuggestion,
  type BookedShift,
  type CandidateWorker,
  type ShiftSlot,
} from "@/lib/roster-suggestions";

const LAGOS = "Africa/Lagos";
const STANDARD = 480 * 5; // 40 h

function lagos(date: string, time: string): string {
  return new Date(`${date}T${time}:00+01:00`).toISOString();
}

const SITE = "apapa";
const OTHER_SITE = "lekki";

/** Saturday 28 Nov 2026, 18:00 to Sunday 06:00. */
const slot: ShiftSlot = {
  postId: "night",
  siteId: SITE,
  date: "2026-11-28",
  startsAt: lagos("2026-11-28", "18:00"),
  endsAt: lagos("2026-11-29", "06:00"),
  weekStart: "2026-11-23",
};

function worker(
  id: string,
  firstName: string,
  lastName: string,
  overrides: Partial<CandidateWorker> = {},
): CandidateWorker {
  return {
    id,
    staffId: `EMP-${id}`,
    firstName,
    lastName,
    startDate: "2024-01-01",
    endDate: null,
    ended: false,
    mappings: [{ siteId: SITE, from: "2024-01-01", to: null }],
    ...overrides,
  };
}

function booked(
  workerId: string,
  date: string,
  start: string,
  end: string,
  postName = "Gate A · Day",
): BookedShift {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const endDate = end <= start ? next.toISOString().slice(0, 10) : date;
  return {
    workerId,
    shiftId: `${workerId}-${date}`,
    postName,
    date,
    startsAt: lagos(date, start),
    endsAt: lagos(endDate, end),
  };
}

const options = { weeklyStandardMinutes: STANDARD, timeZone: LAGOS };

describe("rankCandidates", () => {
  it("puts people mapped to the site first, then the relief pool, then people mapped elsewhere", () => {
    const ranked = rankCandidates(
      slot,
      [
        worker("3", "Kunle", "Ade", { mappings: [] }),
        worker("4", "Emeka", "Nwosu", {
          mappings: [{ siteId: OTHER_SITE, from: "2024-01-01", to: null }],
        }),
        worker("1", "Yusuf", "Bello"),
      ],
      [],
      options,
    );
    expect(ranked.map((s) => s.name)).toEqual(["Yusuf Bello", "Kunle Ade", "Emeka Nwosu"]);
    expect(ranked[0]!.reason).toBe("Off Saturday · 0 h this week");
    expect(ranked[1]!.reason).toBe("Relief pool · 0 h this week");
    expect(ranked[1]!.flags).toEqual(["relief_pool"]);
    expect(ranked[2]!.reason).toBe("Not mapped to this site · 0 h this week");
    expect(ranked[2]!.flags).toEqual(["not_mapped"]);
    expect(ranked.every((s) => s.eligible)).toBe(true);
  });

  it("uses the mapping in force on the day", () => {
    const ranked = rankCandidates(
      slot,
      [
        worker("1", "Yusuf", "Bello", {
          mappings: [
            { siteId: SITE, from: "2024-01-01", to: "2026-11-27" },
            { siteId: OTHER_SITE, from: "2026-11-28", to: null },
          ],
        }),
      ],
      [],
      options,
    );
    expect(ranked[0]!.mapped).toBe(false);
    expect(ranked[0]!.flags).toEqual(["not_mapped"]);
  });

  it("counts this week's hours (Monday to Sunday only) and prefers fewer", () => {
    const ranked = rankCandidates(
      slot,
      [worker("1", "Yusuf", "Bello"), worker("2", "Sadiq", "Musa")],
      [
        // Yusuf: Mon to Wed, 12 h each = 36 h.
        booked("1", "2026-11-23", "06:00", "18:00"),
        booked("1", "2026-11-24", "06:00", "18:00"),
        booked("1", "2026-11-25", "06:00", "18:00"),
        // Last week's Sunday night doesn't count towards this week.
        booked("2", "2026-11-22", "18:00", "06:00"),
        booked("2", "2026-11-26", "06:00", "18:00"),
      ],
      options,
    );
    expect(ranked.map((s) => [s.name, s.weekMinutes])).toEqual([
      ["Sadiq Musa", 720],
      ["Yusuf Bello", 2160],
    ]);
    expect(ranked[0]!.reason).toBe("Off Saturday · 12 h this week");
  });

  it("flags people this shift brings within 4 h of the standard, or over it, and ranks them lower", () => {
    const thirty = [
      booked("near", "2026-11-23", "06:00", "18:00"),
      booked("near", "2026-11-24", "06:00", "18:00"),
      booked("near", "2026-11-25", "06:00", "12:00"),
    ]; // 30 h; +12 h = 42 h: over 40
    const sixteen = [booked("ok", "2026-11-23", "06:00", "22:00")]; // 16 h; +12 = 28 h
    const twentyFour = [
      booked("close", "2026-11-23", "06:00", "18:00"),
      booked("close", "2026-11-24", "06:00", "14:00"),
      booked("close", "2026-11-25", "06:00", "14:00"),
    ]; // 28 h... +12 = 40 h: within 4 h (exactly at the standard)
    const ranked = rankCandidates(
      slot,
      [
        worker("near", "Ngozi", "Eze"),
        worker("ok", "Bayo", "Kola"),
        worker("close", "Halima", "Bello"),
      ],
      [...thirty, ...sixteen, ...twentyFour],
      options,
    );
    expect(ranked.map((s) => s.name)).toEqual(["Bayo Kola", "Halima Bello", "Ngozi Eze"]);
    expect(ranked[1]!.flags).toEqual(["near_standard"]);
    expect(ranked[1]!.reason).toBe(
      "Off Saturday · 28 h this week · within 4 h of the weekly standard",
    );
    expect(ranked[2]!.flags).toEqual(["over_standard"]);
    expect(ranked[2]!.eligible).toBe(true);
    expect(NEAR_STANDARD_MINUTES).toBe(240);
  });

  it("never suggests leavers, people who haven't started or are on leave, or double-booked people", () => {
    const ranked = rankCandidates(
      slot,
      [
        worker("left", "Peter", "Adams", { ended: true, endDate: "2026-11-20" }),
        worker("leaving", "Sule", "Musa", { endDate: "2026-11-27" }),
        worker("new", "Ada", "Obi", { startDate: "2026-12-01" }),
        worker("leave", "Grace", "Ani"),
        worker("busy", "Ibrahim", "Sule"),
        worker("free", "Yusuf", "Bello"),
      ],
      // Ibrahim's Saturday day shift runs to 19:00, an hour into the night shift.
      [booked("busy", "2026-11-28", "07:00", "19:00", "Warehouse floor · Day")],
      { ...options, onLeave: (id) => id === "leave" },
    );
    expect(ranked[0]!.name).toBe("Yusuf Bello");
    const blocked = Object.fromEntries(
      ranked.filter((s) => !s.eligible).map((s) => [s.name, s.blocked]),
    );
    expect(blocked).toEqual({
      "Peter Adams": "Has left the company",
      "Sule Musa": "Leaves on Fri 27 Nov",
      "Ada Obi": "Starts on Tue 1 Dec",
      "Grace Ani": "On leave",
      "Ibrahim Sule": "Double-booked: Warehouse floor · Day Sat 28 Nov 07:00–19:00",
    });
  });

  it("catches an overnight shift the day before running into this one", () => {
    const morning: ShiftSlot = {
      ...slot,
      date: "2026-11-27",
      startsAt: lagos("2026-11-27", "05:00"),
      endsAt: lagos("2026-11-27", "13:00"),
    };
    const ranked = rankCandidates(
      morning,
      [worker("1", "Daniel", "Okafor")],
      [booked("1", "2026-11-26", "18:00", "06:00", "Gate A · Night")],
      options,
    );
    expect(ranked[0]!.eligible).toBe(false);
    expect(ranked[0]!.blocked).toBe("Double-booked: Gate A · Night Thu 26 Nov 18:00–06:00");
  });

  it("allows back-to-back shifts and says 'Mapped here' when they work earlier that day", () => {
    const ranked = rankCandidates(
      slot,
      [worker("1", "Musa", "Ibrahim")],
      [booked("1", "2026-11-28", "06:00", "18:00")],
      options,
    );
    expect(ranked[0]!.eligible).toBe(true);
    expect(ranked[0]!.reason).toBe("Mapped here · 12 h this week");
  });

  it("returns the best eligible worker, or null when nobody is free", () => {
    expect(topSuggestion(slot, [worker("1", "Yusuf", "Bello")], [], options)?.firstName).toBe(
      "Yusuf",
    );
    expect(
      topSuggestion(
        slot,
        [worker("1", "Peter", "Adams", { ended: true, endDate: "2026-01-01" })],
        [],
        options,
      ),
    ).toBeNull();
    expect(noLeave()).toBe(false);
  });
});

describe("matchesSearch", () => {
  it("matches every word against the name and staff ID, ignoring case", () => {
    const s = { name: "Yusuf Bello", staffId: "EMP-0042" };
    expect(matchesSearch(s, "")).toBe(true);
    expect(matchesSearch(s, "yusuf")).toBe(true);
    expect(matchesSearch(s, "bello emp-0042")).toBe(true);
    expect(matchesSearch(s, "0042")).toBe(true);
    expect(matchesSearch(s, "yusuf musa")).toBe(false);
  });
});
