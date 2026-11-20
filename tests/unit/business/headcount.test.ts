/**
 * Slice 2.5: the pure headcount library (src/lib/headcount.ts). Weekly totals to the kobo from
 * the rate card, night shifts across midnight, a 24-hour post, partial weeks, a rate change in a
 * range and the "No rate for ..." flag. Amounts are bigint kobo; nothing here uses floats.
 */
import { describe, expect, it } from "vitest";

import {
  crossesMidnight,
  durationMinutes,
  expandRange,
  expandWeek,
  formatDays,
  formatHeadcountTotals,
  formatHours,
  isoWeekday,
  missingRateMessage,
  parseHeadcountInput,
  postLabel,
  previewHeadcountChange,
  pricingDate,
  rangeTotals,
  ratesLabel,
  shiftsPerWeek,
  toHeadcountInput,
  weeklyHeadcount,
  type HeadcountInput,
  type HeadcountLine,
} from "@/lib/headcount";
import {
  findRateLine,
  normaliseKeyPart,
  rateKeyId,
  type RateCardVersion,
  type RateLine,
} from "@/lib/rate-cards";

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
  otMultiplierBps: 15_000,
  serviceType: "services",
  whtRateBps: 500,
  ...over,
});

/** Coastline: Guard Day ₦12,500 a shift, Guard Night ₦15,000 a shift, overtime 1.5×. */
const COASTLINE: RateCardVersion = {
  id: "v1",
  effectiveFrom: "2026-12-01",
  effectiveTo: null,
  note: null,
  lines: [rate({}), rate({ band: "Night", rateKobo: 1_500_000n })],
};

let seq = 0;
const row = (over: Partial<HeadcountLine>): HeadcountLine => ({
  id: `row-${++seq}`,
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

/** A rolling manned-post contract that started before every range below. */
const OPEN = { type: "manned_post", startDate: "2026-11-01", endDate: null };

/** The board's four posts at two sites (docs/PHASE_2.md test plan). */
const FOUR = [
  row({ postName: "Gate A", band: "Day" }),
  row({ postName: "Gate A", band: "Night", startTime: "18:00", endTime: "06:00" }),
  row({ siteId: GATE_B, postName: "Patrol", band: "Night", startTime: "18:00", endTime: "06:00" }),
  row({ siteId: GATE_B, postName: "Warehouse floor", band: "Day" }),
];

describe("times", () => {
  it("works out the length, with the end at or before the start meaning the next day", () => {
    expect(durationMinutes("06:00", "18:00")).toBe(720);
    expect(durationMinutes("18:00", "06:00")).toBe(720);
    expect(durationMinutes("22:00", "06:30")).toBe(510);
    expect(durationMinutes("06:00", "06:00")).toBe(1440);
    expect(durationMinutes("06:00:00", "06:15:00")).toBe(15);
    expect(crossesMidnight("18:00", "06:00")).toBe(true);
    expect(crossesMidnight("06:00", "18:00")).toBe(false);
  });

  it("names posts, days and hours the way the tab shows them", () => {
    expect(postLabel(row({}))).toBe("Gate A · Day");
    expect(postLabel(row({ postName: null, band: "Night" }))).toBe("Guard · Night");
    expect(postLabel(row({ postName: "Reception", band: "standard" }))).toBe("Reception");
    expect(formatDays(EVERY_DAY)).toBe("Every day");
    expect(formatDays([1, 2, 3, 4, 5])).toBe("Mon–Fri");
    expect(formatDays([6, 7])).toBe("Sat–Sun");
    expect(formatDays([1, 3, 5])).toBe("Mon, Wed, Fri");
    expect(formatDays([1, 2, 3, 6])).toBe("Mon–Wed, Sat");
    expect(formatHours(row({}))).toBe("06:00–18:00");
    expect(formatHours(row({ startTime: "18:00:00", endTime: "06:00:00" }))).toBe(
      "18:00–06:00 (next day)",
    );
    expect(formatHours(row({ startTime: "06:00", endTime: "06:00" }))).toBe("24 hours from 06:00");
  });

  it("knows the ISO weekday of a date", () => {
    expect(isoWeekday("2026-11-19")).toBe(4); // Thursday
    expect(isoWeekday("2026-11-22")).toBe(7); // Sunday
    expect(isoWeekday("2026-11-23")).toBe(1); // Monday
  });
});

describe("expandWeek and shiftsPerWeek", () => {
  it("expands a week with a Sunday night shift ending after the week", () => {
    const night = row({ band: "Night", startTime: "18:00", endTime: "06:00", daysOfWeek: [5, 7] });
    const week = expandWeek([night]);
    expect(week).toEqual([
      { line: 0, weekday: 5, startsAt: 4 * 1440 + 1080, endsAt: 5 * 1440 + 360, people: 1 },
      { line: 0, weekday: 7, startsAt: 6 * 1440 + 1080, endsAt: 7 * 1440 + 360, people: 1 },
    ]);
    expect(week[1]!.endsAt).toBeGreaterThan(7 * 1440);
  });

  it("counts person-shifts as days times people", () => {
    expect(shiftsPerWeek(row({ requiredCount: 3, daysOfWeek: [1, 2, 3, 4, 5] }))).toBe(15);
    expect(FOUR.reduce((n, r) => n + shiftsPerWeek(r), 0)).toBe(28);
  });
});

describe("weeklyHeadcount", () => {
  it("prices a manned-post contract at two sites to the kobo", () => {
    const week = weeklyHeadcount(FOUR, COASTLINE, "manned_post");
    expect(week.posts).toBe(4);
    expect(week.shifts).toBe(28);
    // 14 day shifts at ₦12,500 and 14 night shifts at ₦15,000.
    expect(week.weeklyKobo).toBe(14n * 1_250_000n + 14n * 1_500_000n);
    expect(week.weeklyKobo).toBe(38_500_000n);
    expect(week.unpriced).toBe(0);
    expect(week.sites.map((s) => [s.siteId, s.posts, s.shifts, s.weeklyKobo])).toEqual([
      [APAPA, 2, 14, 19_250_000n],
      [GATE_B, 2, 14, 19_250_000n],
    ]);
    expect(formatHeadcountTotals(week, ratesLabel("2026-12-01", "2026-12-01"))).toBe(
      "4 posts · 28 shifts a week · ₦385,000 a week at today's rates",
    );
  });

  it("flags a row whose rate key has no line and leaves it out of the total", () => {
    const rows = [...FOUR, row({ postName: "Gate C", band: "Supervisor", requiredCount: 2 })];
    const week = weeklyHeadcount(rows, COASTLINE, "manned_post");
    const supervisor = week.rows[4]!;
    expect(supervisor.missingRate).toBe(true);
    expect(supervisor.weeklyKobo).toBeNull();
    expect(missingRateMessage(supervisor.line)).toBe("No rate for Guard · Supervisor");
    expect(week.unpriced).toBe(1);
    expect(week.missingKeys).toEqual([{ role: "Guard", band: "Supervisor", unit: "shift" }]);
    expect(week.weeklyKobo).toBe(38_500_000n);
    expect(week.shifts).toBe(42);
  });

  it("matches the key ignoring case, and needs the same unit", () => {
    const week = weeklyHeadcount(
      [row({ role: "guard", band: "DAY" }), row({ unit: "hour" })],
      COASTLINE,
      "manned_post",
    );
    expect(week.rows[0]!.weeklyKobo).toBe(7n * 1_250_000n);
    expect(week.rows[1]!.missingRate).toBe(true);
    expect(missingRateMessage(week.rows[1]!.line)).toBe("No rate for Guard · Day an hour");
  });

  it("flags every row when there is no rate card", () => {
    const week = weeklyHeadcount(FOUR, null, "manned_post");
    expect(week.unpriced).toBe(4);
    expect(week.weeklyKobo).toBeNull();
    expect(formatHeadcountTotals(week, "at today's rates")).toBe("4 posts · 28 shifts a week");
  });

  it("prices hourly rows once per row-week, rounding half away from zero", () => {
    const hourly: RateCardVersion = {
      ...COASTLINE,
      lines: [rate({ role: "Cleaner", band: "standard", unit: "hour", rateKobo: 1001n })],
    };
    const quarter = (days: number[]) =>
      row({
        role: "Cleaner",
        band: "standard",
        unit: "hour",
        startTime: "06:00",
        endTime: "06:15",
        daysOfWeek: days,
      });
    // 15 minutes at 1,001 kobo an hour is 250.25 kobo: 250.
    expect(weeklyHeadcount([quarter([1])], hourly, "manned_post").weeklyKobo).toBe(250n);
    // Two of them are 500.5 kobo: 501, not 250 + 250.
    expect(weeklyHeadcount([quarter([1, 2])], hourly, "manned_post").weeklyKobo).toBe(501n);
  });

  it("prices a 24-hour post by the hour", () => {
    const hourly: RateCardVersion = {
      ...COASTLINE,
      lines: [rate({ unit: "hour", band: "standard", rateKobo: 100_050n })],
    };
    const post = row({ band: "", unit: "hour", startTime: "06:00", endTime: "06:00" });
    const week = weeklyHeadcount([post], hourly, "manned_post");
    expect(week.rows[0]!.minutesPerWeek).toBe(7 * 1440);
    // ₦1,000.50 an hour × 168 hours.
    expect(week.weeklyKobo).toBe(100_050n * 168n);
    expect(week.weeklyKobo).toBe(16_808_400n);
  });

  it("counts visits apart from shifts", () => {
    const visits: RateCardVersion = {
      ...COASTLINE,
      lines: [rate({ role: "Patrol", band: "standard", unit: "visit", rateKobo: 450_000n })],
    };
    const patrol = row({
      postName: null,
      role: "Patrol",
      band: "standard",
      unit: "visit",
      startTime: "22:00",
      endTime: "23:00",
      daysOfWeek: [1, 3, 5],
      requiredCount: 2,
    });
    const week = weeklyHeadcount([patrol], visits, "per_visit");
    expect([week.shifts, week.visits, week.weeklyKobo]).toEqual([0, 6, 2_700_000n]);
    expect(formatHeadcountTotals(week, "at today's rates")).toBe(
      "1 post · 6 visits a week · ₦27,000 a week at today's rates",
    );
  });

  it("doesn't price or flag rows on a fixed-monthly contract", () => {
    const week = weeklyHeadcount([row({ band: "Supervisor" })], COASTLINE, "fixed_monthly");
    expect(week.priced).toBe(false);
    expect(week.unpriced).toBe(0);
    expect(week.weeklyKobo).toBeNull();
    expect(formatHeadcountTotals(week, "at today's rates")).toBe("1 post · 7 shifts a week");
  });
});

describe("expandRange and rangeTotals", () => {
  it("counts a partial week, a night shift belonging to the day it starts", () => {
    // Friday 4 Dec to Sunday 6 Dec 2026: a Mon–Fri night post works Friday night only.
    const weekdayNights = row({
      band: "Night",
      startTime: "18:00",
      endTime: "06:00",
      daysOfWeek: [1, 2, 3, 4, 5],
    });
    const days = row({});
    const range = expandRange([weekdayNights, days], "2026-12-04", "2026-12-06");
    expect(range.filter((o) => o.line === 0)).toEqual([
      {
        line: 0,
        date: "2026-12-04",
        startsAt: "2026-12-04T18:00",
        endsAt: "2026-12-05T06:00",
        people: 1,
      },
    ]);
    expect(range.filter((o) => o.line === 1)).toHaveLength(3);
    const totals = rangeTotals(
      [weekdayNights, days],
      [COASTLINE],
      { from: "2026-12-04", to: "2026-12-06" },
      OPEN,
    );
    expect(totals).toEqual({
      shifts: 4,
      visits: 0,
      billableKobo: 1_500_000n + 3n * 1_250_000n,
      unpricedOccurrences: 0,
    });
  });

  it("prices each day at the rate card in force on it", () => {
    const december = { ...COASTLINE, effectiveTo: "2026-12-31" };
    const january: RateCardVersion = {
      id: "v2",
      effectiveFrom: "2027-01-01",
      effectiveTo: null,
      note: null,
      lines: [rate({ rateKobo: 1_300_000n }), rate({ band: "Night", rateKobo: 1_500_000n })],
    };
    // Monday 28 Dec 2026 to Sunday 3 Jan 2027: 4 days at ₦12,500, 3 at ₦13,000.
    const totals = rangeTotals(
      [row({})],
      [december, january],
      { from: "2026-12-28", to: "2027-01-03" },
      OPEN,
    );
    expect(totals.billableKobo).toBe(4n * 1_250_000n + 3n * 1_300_000n);
    expect(totals.billableKobo).toBe(8_900_000n);
  });

  it("counts days before the first rate card as unpriced", () => {
    const totals = rangeTotals(
      [row({ requiredCount: 2 })],
      [COASTLINE],
      { from: "2026-11-29", to: "2026-12-01" },
      OPEN,
    );
    expect(totals.unpricedOccurrences).toBe(4);
    expect(totals.billableKobo).toBe(2n * 1_250_000n);
  });

  it("rounds hourly rows once per row and rate card", () => {
    const hourly: RateCardVersion = {
      ...COASTLINE,
      lines: [rate({ band: "standard", unit: "hour", rateKobo: 1001n })],
    };
    const quarter = row({ band: "", unit: "hour", startTime: "06:00", endTime: "06:15" });
    expect(
      rangeTotals([quarter], [hourly], { from: "2026-12-01", to: "2026-12-02" }, OPEN).billableKobo,
    ).toBe(501n);
  });
});

describe("pricingDate and ratesLabel", () => {
  it("uses today, else the start date, else the end date", () => {
    expect(pricingDate("2026-11-19", "2026-12-01", null)).toBe("2026-12-01");
    expect(pricingDate("2026-12-10", "2026-12-01", null)).toBe("2026-12-10");
    expect(pricingDate("2027-02-01", "2026-12-01", "2026-12-31")).toBe("2026-12-31");
    expect(ratesLabel("2026-12-01", "2026-11-19")).toBe("at the rates on 1 Dec 2026");
  });
});

describe("parseHeadcountInput", () => {
  const input = (over: Partial<HeadcountInput> = {}): HeadcountInput => ({
    siteId: APAPA,
    postName: " Gate A ",
    role: "Guard",
    band: "Night",
    unit: "shift",
    days: ["7", "1", "1"],
    startTime: "18:00",
    endTime: "06:00",
    requiredCount: "2",
    notes: "",
    ...over,
  });

  it("reads a typed row, with the days sorted and each once", () => {
    const parsed = parseHeadcountInput(input());
    expect(parsed).toEqual({
      ok: true,
      line: {
        siteId: APAPA,
        postName: "Gate A",
        role: "Guard",
        band: "Night",
        unit: "shift",
        daysOfWeek: [1, 7],
        startTime: "18:00",
        endTime: "06:00",
        requiredCount: 2,
        notes: null,
      },
    });
    if (parsed.ok) expect(parseHeadcountInput(toHeadcountInput(parsed.line))).toEqual(parsed);
  });

  it("puts each problem under its field", () => {
    const parsed = parseHeadcountInput(
      input({
        siteId: "",
        role: "",
        unit: "month",
        days: [],
        startTime: "06:10",
        endTime: "25:00",
        requiredCount: "0",
        postName: "<b>",
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(Object.keys(parsed.errors).sort()).toEqual(
      [
        "days",
        "endTime",
        "postName",
        "requiredCount",
        "role",
        "siteId",
        "startTime",
        "unit",
      ].sort(),
    );
    expect(parseHeadcountInput(input({ requiredCount: "201" })).ok).toBe(false);
    expect(parseHeadcountInput(input({ days: ["8"] })).ok).toBe(false);
  });

  it("treats a blank band as standard and a blank post as none", () => {
    const parsed = parseHeadcountInput(input({ band: " ", postName: "" }));
    expect(parsed.ok && [parsed.line.band, parsed.line.postName]).toEqual(["standard", null]);
  });
});

describe("previewHeadcountChange", () => {
  const siteName = (id: string) => (id === APAPA ? "Apapa Warehouse 3" : "Gate B");

  it("says what an added row does to the weekly total", () => {
    const [first, second, third, fourth] = FOUR;
    const preview = previewHeadcountChange({
      before: [first!, second!, third!],
      after: [first!, second!, third!, fourth!],
      version: COASTLINE,
      contractType: "manned_post",
      siteName,
      ratesLabel: "at today's rates",
    });
    expect(preview.summary).toBe(
      "Adds Warehouse floor · Day at Gate B. 4 posts · 28 shifts a week · ₦385,000 a week at today's rates.",
    );
    expect(preview.changes).toEqual([
      {
        label: "Warehouse floor · Day at Gate B",
        after: "Every day 06:00–18:00 × 1: 7 shifts a week · ₦87,500 a week",
      },
      {
        label: "Weekly total",
        before: "3 posts · 21 shifts a week · ₦297,500 a week at today's rates",
        after: "4 posts · 28 shifts a week · ₦385,000 a week at today's rates",
      },
    ]);
  });

  it("names changed and removed rows and flags rows with no rate", () => {
    const [first, second] = FOUR;
    const changed = { ...second!, band: "Supervisor" };
    const preview = previewHeadcountChange({
      before: [first!, second!],
      after: [changed],
      version: COASTLINE,
      contractType: "manned_post",
      siteName,
      ratesLabel: "at today's rates",
    });
    expect(preview.summary).toBe(
      "Changes Gate A · Supervisor at Apapa Warehouse 3; removes Gate A · Day at Apapa Warehouse 3. 1 post · 7 shifts a week. 1 row has no rate.",
    );
    expect(preview.changes[0]).toMatchObject({
      label: "Gate A · Supervisor at Apapa Warehouse 3",
      after:
        "Every day 18:00–06:00 (next day) × 1: 7 shifts a week · No rate for Guard · Supervisor",
    });
    expect(preview.changes[1]).toMatchObject({
      label: "Gate A · Day at Apapa Warehouse 3",
      after: "Removed",
    });
  });
});

describe("money review (slice 2.5)", () => {
  it("clamps a range to the contract's dates: a contract ending mid-week", () => {
    // Monday 7 Dec to Sunday 13 Dec 2026; the contract ends on Wednesday 9 Dec.
    const ending = { ...OPEN, endDate: "2026-12-09" };
    const totals = rangeTotals(
      [row({})],
      [COASTLINE],
      { from: "2026-12-07", to: "2026-12-13" },
      ending,
    );
    expect(totals).toEqual({
      shifts: 3,
      visits: 0,
      billableKobo: 3n * 1_250_000n,
      unpricedOccurrences: 0,
    });
    // A contract starting on Friday 11 Dec counts Friday to Sunday only.
    const starting = { ...OPEN, startDate: "2026-12-11" };
    expect(
      rangeTotals(
        [row({})],
        [{ ...COASTLINE, effectiveFrom: "2026-12-11" }],
        { from: "2026-12-07", to: "2026-12-13" },
        starting,
      ),
    ).toEqual({ shifts: 3, visits: 0, billableKobo: 3n * 1_250_000n, unpricedOccurrences: 0 });
  });

  it("matches a whole-weeks range to the sum of its weeks, except hourly rounding", () => {
    const one = weeklyHeadcount(FOUR, COASTLINE, "manned_post").weeklyKobo!;
    const two = rangeTotals(FOUR, [COASTLINE], { from: "2026-12-07", to: "2026-12-20" }, OPEN);
    expect(two.billableKobo).toBe(2n * one);
    // Hourly rows round once per row and rate version over the range: 15 minutes at 1,001 kobo
    // an hour on Mondays is 250.25 kobo a week (250), but 500.5 over two weeks (501).
    const hourly: RateCardVersion = {
      ...COASTLINE,
      lines: [rate({ band: "standard", unit: "hour", rateKobo: 1001n })],
    };
    const quarter = row({
      band: "",
      unit: "hour",
      startTime: "06:00",
      endTime: "06:15",
      daysOfWeek: [1],
    });
    expect(weeklyHeadcount([quarter], hourly, "manned_post").weeklyKobo).toBe(250n);
    expect(
      rangeTotals([quarter], [hourly], { from: "2026-12-07", to: "2026-12-20" }, OPEN).billableKobo,
    ).toBe(501n);
  });

  it("normalises rate keys one way: Unicode spaces, trimming and ASCII-only case", () => {
    expect(normaliseKeyPart("  Agent\u00a0de   sécurité\u200b ")).toBe("agent de sécurité");
    expect(normaliseKeyPart("AGENT DE SéCURITé")).toBe("agent de sécurité");
    // Non-ASCII capitals are not folded, in JavaScript or in SQL (private.rate_key_part).
    expect(normaliseKeyPart("AGENT DE SÉCURITÉ")).toBe("agent de sÉcuritÉ");
    expect(rateKeyId({ role: "Guard", band: "\u00a0", unit: "shift" })).toBe(
      "guard|standard|shift",
    );
    const version = { lines: [rate({ role: "Agent de sécurité", band: "Nuit" })] };
    expect(
      findRateLine(version, { role: "agent\u00a0de sécurité", band: " NUIT ", unit: "shift" }),
    ).not.toBeNull();
    expect(
      findRateLine(version, { role: "AGENT DE SÉCURITÉ", band: "Nuit", unit: "shift" }),
    ).toBeNull();
    const week = weeklyHeadcount(
      [row({ role: "Agent de sécurité", band: "nuit" })],
      version,
      "manned_post",
    );
    expect(week.unpriced).toBe(0);
  });
});
