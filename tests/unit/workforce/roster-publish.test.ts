/**
 * Slice 3.3: the pure parts of publishing a roster: reading publish_roster's result, the status
 * line, the notice each worker gets (always within the inbox rules) and the "who was told" line.
 */
import { describe, expect, it } from "vitest";

import { hasPersonalNumberRun, inboxMessageSchema } from "@/lib/inbox";
import {
  NOTICE_MAX_LINES,
  buildShiftNotice,
  formatChangeCounts,
  formatNotifyTally,
  formatPublicationStatus,
  pickShiftsToday,
  toPublicationStatus,
  toPublishResult,
  type PublishedShift,
} from "@/lib/roster-publish";

const TZ = "Africa/Lagos";
const WEEK = "2026-11-23";

function shift(
  date: string,
  start: string,
  end: string,
  postName = "Gate A · Day",
): PublishedShift {
  const endDate = end < start ? addOne(date) : date;
  return {
    date,
    startsAt: new Date(`${date}T${start}:00+01:00`).toISOString(),
    endsAt: new Date(`${endDate}T${end}:00+01:00`).toISOString(),
    postName,
  };
}

function addOne(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe("toPublishResult", () => {
  it("reads the database's jsonb and survives missing fields", () => {
    const r = toPublishResult({
      publication_id: "p1",
      version: 2,
      previous_version: 1,
      published_at: "2026-11-21T13:05:00Z",
      site_id: "s1",
      site_name: "Apapa Warehouse 3",
      time_zone: TZ,
      week_start: WEEK,
      assigned: 5,
      open: 2,
      dry_run: false,
      nothing_changed: false,
      counts: { added: 1, removed: 1, changed: 0 },
      affected: [
        {
          worker_id: "w1",
          worker_name: "Musa Ibrahim",
          kind: "added",
          shifts: [
            {
              shift_date: WEEK,
              starts_at: "2026-11-23T05:00:00+00:00",
              ends_at: "2026-11-23T17:00:00+00:00",
              post_name: "Gate A · Day",
            },
          ],
        },
        { worker_id: "w2", worker_name: "Daniel Okafor", kind: "removed", shifts: [] },
        { worker_id: "w3", kind: "nonsense" },
      ],
    });
    expect(r).toMatchObject({ version: 2, previousVersion: 1, assigned: 5, open: 2 });
    expect(r.affected.map((a) => a.kind)).toEqual(["added", "removed", "changed"]);
    expect(r.affected[0]!.shifts[0]).toEqual({
      date: WEEK,
      startsAt: "2026-11-23T05:00:00+00:00",
      endsAt: "2026-11-23T17:00:00+00:00",
      postName: "Gate A · Day",
    });
    expect(toPublishResult(null)).toMatchObject({
      version: 0,
      previousVersion: null,
      affected: [],
      timeZone: TZ,
    });
  });
});

describe("the status line", () => {
  it("says Not published, or the version and when in the company's time", () => {
    expect(formatPublicationStatus({ version: null, publishedAt: null }, TZ)).toBe("Not published");
    expect(formatPublicationStatus({ version: 2, publishedAt: "2026-11-21T13:05:00Z" }, TZ)).toBe(
      "Published · version 2 · 21 Nov 14:05",
    );
    // 23:30 UTC is the next day in Lagos.
    expect(formatPublicationStatus({ version: 1, publishedAt: "2026-11-21T23:30:00Z" }, TZ)).toBe(
      "Published · version 1 · 22 Nov 00:30",
    );
  });

  it("reads the changed post-days as keys", () => {
    const s = toPublicationStatus({
      version: 3,
      published_at: "2026-11-21T13:05:00Z",
      workers_affected: 2,
      changed: [{ post_id: "p1", shift_date: WEEK }],
    });
    expect(s).toMatchObject({ version: 3, workersAffected: 2, changed: [`p1|${WEEK}`] });
    expect(toPublicationStatus({ version: null })).toMatchObject({ version: null, changed: [] });
  });

  it("counts changes for the confirm step", () => {
    expect(formatChangeCounts({ added: 2, removed: 1, changed: 1 })).toBe(
      "2 workers added, 1 worker taken off, 1 worker with changed shifts",
    );
    expect(formatChangeCounts({ added: 0, removed: 0, changed: 0 })).toBe("No changes for anyone");
  });
});

describe("buildShiftNotice", () => {
  it("lists the worker's shifts that week, one line each, in order", () => {
    const m = buildShiftNotice({
      siteName: "Apapa Warehouse 3",
      weekStart: WEEK,
      timeZone: TZ,
      republish: false,
      shifts: [
        shift("2026-11-24", "18:00", "06:00", "Gate A · Night"),
        shift(WEEK, "06:00", "18:00"),
      ],
    });
    expect(m).toEqual({
      kind: "shift_published",
      title: "Your shifts for the week of 23 Nov",
      body: [
        "At Apapa Warehouse 3:",
        "Mon 23 Nov 06:00–18:00 Gate A · Day",
        "Tue 24 Nov 18:00–06:00 Gate A · Night",
        "Open My shifts for the details.",
      ].join("\n"),
      link: "/m/shifts",
    });
    expect(inboxMessageSchema.safeParse(m).success).toBe(true);
  });

  it("says the shifts changed on a republish, and tells someone taken off every shift", () => {
    const changed = buildShiftNotice({
      siteName: "Apapa Warehouse 3",
      weekStart: WEEK,
      timeZone: TZ,
      republish: true,
      shifts: [shift("2026-11-25", "06:00", "18:00")],
    });
    expect(changed.title).toBe("Your shifts changed for the week of 23 Nov");
    const removed = buildShiftNotice({
      siteName: "Apapa Warehouse 3",
      weekStart: WEEK,
      timeZone: TZ,
      republish: true,
      shifts: [],
    });
    expect(removed.body).toBe(
      "You are no longer on any shift at Apapa Warehouse 3 in the week of 23 Nov.",
    );
  });

  it("stays under the length limit and counts what it leaves out", () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      shift(
        `2026-11-${String(23 + (i % 7)).padStart(2, "0")}`,
        i < 7 ? "06:00" : "18:00",
        i < 7 ? "18:00" : "23:00",
        `A very long post name that goes on and on for quite a while number ${i}`,
      ),
    );
    const m = buildShiftNotice({
      siteName: "S".repeat(200),
      weekStart: WEEK,
      timeZone: TZ,
      republish: false,
      shifts: many,
    });
    expect(m.body.length).toBeLessThanOrEqual(1000);
    expect(m.body.split("\n")).toHaveLength(NOTICE_MAX_LINES + 3);
    expect(m.body).toContain("and 4 more");
    expect(inboxMessageSchema.safeParse(m).success).toBe(true);
  });

  it("never carries a run of 10 or more digits or a web address: it falls back to plain words", () => {
    for (const name of ["Gate 0123456789", "Gate 0123 456 7890", "www.example.com gate"]) {
      const m = buildShiftNotice({
        siteName: "Apapa Warehouse 3",
        weekStart: WEEK,
        timeZone: TZ,
        republish: false,
        shifts: [shift(WEEK, "06:00", "18:00", name)],
      });
      expect(inboxMessageSchema.safeParse(m).success, name).toBe(true);
      expect(hasPersonalNumberRun(`${m.title} ${m.body}`)).toBe(false);
      expect(m.body).toBe(
        "Your shifts for the week of 23 Nov are ready. Open My shifts to see them.",
      );
    }
  });

  it("strips markup and control characters from names", () => {
    const m = buildShiftNotice({
      siteName: "Apapa <b>3</b>",
      weekStart: WEEK,
      timeZone: TZ,
      republish: false,
      shifts: [shift(WEEK, "06:00", "18:00", "Gate\u0007 A")],
    });
    expect(m.body).not.toMatch(/[<>\u0007]/);
    expect(inboxMessageSchema.safeParse(m).success).toBe(true);
  });
});

describe("formatNotifyTally", () => {
  it("says who was told in the app, by email, and what the daily limit held back", () => {
    expect(
      formatNotifyTally({ inApp: 2, emailed: 1, capped: 0, noEmail: 0, emailFailed: 1, failed: 0 }),
    ).toBe("2 workers told in the app, 1 by email, 1 email failed to send");
    expect(
      formatNotifyTally({ inApp: 3, emailed: 2, capped: 1, noEmail: 0, emailFailed: 0, failed: 0 }),
    ).toBe("3 workers told in the app, 2 by email, 1 email held back by the daily limit");
    expect(
      formatNotifyTally({ inApp: 1, emailed: 0, capped: 0, noEmail: 1, emailFailed: 0, failed: 0 }),
    ).toBe("1 worker told in the app, 0 by email");
    expect(
      formatNotifyTally({ inApp: 0, emailed: 0, capped: 0, noEmail: 0, emailFailed: 0, failed: 0 }),
    ).toBe("No one needed telling");
    expect(
      formatNotifyTally({ inApp: 2, emailed: 0, capped: 0, noEmail: 0, emailFailed: 0, failed: 1 }),
    ).toBe("2 workers told in the app, 0 by email, 1 worker not told yet");
  });
});

describe("pickShiftsToday", () => {
  const now = Date.parse("2026-11-24T03:00:00+01:00");
  it("shows last night's shift while it runs, then today's", () => {
    const night = { ...shift(WEEK, "18:00", "06:00"), id: "n" };
    const day = { ...shift("2026-11-24", "06:00", "18:00"), id: "d" };
    expect(pickShiftsToday([night, day], "2026-11-24", now)).toEqual({ shift: night, more: 1 });
    const later = Date.parse("2026-11-24T07:00:00+01:00");
    expect(pickShiftsToday([night, day], "2026-11-24", later)).toEqual({ shift: day, more: 0 });
    expect(pickShiftsToday([], "2026-11-24", now)).toEqual({ shift: null, more: 0 });
  });
});
