import { describe, expect, it } from "vitest";

import {
  formatDistance,
  noteProblem,
  pickSite,
  previewSite,
  punchPayloadSchema,
  type ClockSite,
} from "@/lib/punches/clock";

const centre = { lat: 6.4474, lng: 3.3611 };
const site: ClockSite = {
  id: "s1",
  name: "Apapa Warehouse 3",
  centre,
  radiusM: 100,
  boundary: null,
  hasGeofence: true,
};
/** About `m` metres north of the centre. */
const north = (m: number) => ({ lat: centre.lat + m / 111_195, lng: centre.lng });

describe("clock screen preview", () => {
  it("inside, near and outside a radius", () => {
    expect(previewSite(site, north(40), 10)).toEqual({ distanceM: 40, result: "inside" });
    expect(previewSite(site, north(130), 50).result).toBe("near");
    expect(previewSite(site, north(620), 20)).toEqual({ distanceM: 620, result: "outside" });
  });

  it("inside a drawn outline", () => {
    const box: ClockSite = {
      ...site,
      boundary: [
        { lat: 6.446, lng: 3.36 },
        { lat: 6.446, lng: 3.362 },
        { lat: 6.449, lng: 3.362 },
        { lat: 6.449, lng: 3.36 },
      ],
    };
    expect(previewSite(box, centre, 5).result).toBe("inside");
    expect(previewSite(box, north(2000), 5).result).toBe("outside");
  });

  it("unknown with no geofence", () => {
    expect(previewSite({ ...site, hasGeofence: false }, centre, 5).result).toBe("unknown");
  });

  it("picks the shift's site, else the nearest", () => {
    const far: ClockSite = { ...site, id: "s2", centre: north(5000) };
    expect(pickSite([far, site], "s2", centre)?.id).toBe("s2");
    expect(pickSite([far, site], null, centre)?.id).toBe("s1");
    expect(pickSite([], null, centre)).toBeNull();
  });

  it("formats distances", () => {
    expect(formatDistance(40.4)).toBe("40 m");
    expect(formatDistance(1234)).toBe("1.2 km");
  });
});

describe("outside note", () => {
  it("plain words only, no addresses or long numbers", () => {
    expect(noteProblem("Gate was locked by the client")).toBeNull();
    expect(noteProblem("call me on 0803 123 4567")).toMatch(/numbers/);
    expect(noteProblem("see www.example.com")).toMatch(/web/);
    expect(noteProblem("<b>hi</b>")).toMatch(/plain/);
    expect(noteProblem("x".repeat(281))).toMatch(/280/);
  });

  it("the payload schema refuses a bad note", () => {
    const payload = {
      site_id: null,
      latitude: null,
      longitude: null,
      accuracy_m: null,
      outside_reason: "other",
      outside_note: "ring 08031234567",
      has_selfie: false,
    };
    expect(punchPayloadSchema.safeParse(payload).success).toBe(false);
    expect(punchPayloadSchema.safeParse({ ...payload, outside_note: "Errand" }).success).toBe(true);
  });
});
