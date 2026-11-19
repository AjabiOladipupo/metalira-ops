/**
 * Slice 2.2: the geofence maths and checks shared by the editor and the server, the site and
 * checkpoint schemas, and the QR rotation spec. The database repeats every rule
 * (tests/rls/sites.test.ts).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import {
  OUTLINE_MAX_POINTS,
  circleAreaM2,
  distanceM,
  formatArea,
  formatOutline,
  insideNigeria,
  openRing,
  outlineProblem,
  parseLatLng,
  parseOutline,
  pointEwkt,
  pointsFromGeoJson,
  polygonAreaM2,
  polygonEwkt,
  radiusProblem,
  selfIntersects,
  type LatLng,
} from "@/lib/geofence";
import { runMutation, type MutationContext } from "@/server/identity/mutate";
import { addCheckpointSchema, createSiteSchema, setGeofenceSchema } from "@/server/sites/schemas";
import { rotateCheckpointQrSpec } from "@/server/sites/sites";
import { checkpointUrl, siteNeedsDetails, summariseSites } from "@/server/sites/sites-data";
import type { Database } from "@/types/db";

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));

const SITE = "c0000000-0000-4000-8000-000000000003";
const CHECKPOINT = "d0000000-0000-4000-8000-000000000004";
const ORG = "a0000000-0000-4000-8000-000000000001";

/** A square of `side` metres with its south-west corner at Apapa. */
function square(side: number, at: LatLng = { lat: 6.4474, lng: 3.3611 }): LatLng[] {
  const dLat = side / 111_195;
  const dLng = side / (111_195 * Math.cos((at.lat * Math.PI) / 180));
  return [
    at,
    { lat: at.lat, lng: at.lng + dLng },
    { lat: at.lat + dLat, lng: at.lng + dLng },
    { lat: at.lat + dLat, lng: at.lng },
  ];
}

describe("geofence maths", () => {
  it("measures distance and area in metres", () => {
    const a = { lat: 6.5244, lng: 3.3792 };
    expect(distanceM(a, a)).toBe(0);
    // One thousandth of a degree of latitude is about 111 m.
    expect(distanceM(a, { lat: 6.5254, lng: 3.3792 })).toBeCloseTo(111.2, 0);
    expect(polygonAreaM2(square(100))).toBeCloseTo(10_000, -1);
    expect(circleAreaM2(100)).toBeCloseTo(31_415.9, 0);
  });

  it("knows Nigeria's box", () => {
    expect(insideNigeria({ lat: 6.5244, lng: 3.3792 })).toBe(true); // Lagos
    expect(insideNigeria({ lat: 9.0765, lng: 7.3986 })).toBe(true); // Abuja
    expect(insideNigeria({ lat: 51.5072, lng: -0.1276 })).toBe(false); // London
    expect(insideNigeria({ lat: 0, lng: 0 })).toBe(false);
  });

  it("opens a closed ring and drops repeated corners", () => {
    const ring = square(50);
    expect(openRing([...ring, ring[0]!])).toEqual(ring);
    expect(openRing([ring[0]!, ring[0]!, ring[1]!, ring[2]!])).toHaveLength(3);
  });

  it("finds an outline that crosses itself", () => {
    const [a, b, c, d] = square(100) as [LatLng, LatLng, LatLng, LatLng];
    expect(selfIntersects([a, b, c, d])).toBe(false);
    // A bow tie: a -> c crosses b -> d.
    expect(selfIntersects([a, c, b, d])).toBe(true);
  });
});

describe("radius and outline checks", () => {
  it("allows a radius of 25 to 2,000 whole metres", () => {
    expect(radiusProblem(100)).toBeNull();
    expect(radiusProblem(25)).toBeNull();
    expect(radiusProblem(2000)).toBeNull();
    expect(radiusProblem(24)).toMatch(/between 25 and 2,000/);
    expect(radiusProblem(2001)).toMatch(/between 25 and 2,000/);
    expect(radiusProblem(50.5)).toMatch(/whole metres/);
  });

  it("refuses outlines that are too small, too big, crossed, too detailed or abroad", () => {
    expect(outlineProblem(square(200))).toBeNull();
    expect(outlineProblem(square(200).slice(0, 2))).toMatch(/at least 3 corners/);
    const [a, b, c, d] = square(100) as [LatLng, LatLng, LatLng, LatLng];
    expect(outlineProblem([a, c, b, d])).toMatch(/crosses itself/);
    expect(outlineProblem(square(2100))).toMatch(/4 square kilometres/);
    expect(outlineProblem(square(200, { lat: 51.5, lng: -0.12 }))).toMatch(/in Nigeria/);
    expect(
      outlineProblem([a, { lat: a.lat, lng: a.lng + 0.001 }, { lat: a.lat, lng: a.lng + 0.002 }]),
    ).toMatch(/no area/);
    const circleish = Array.from({ length: OUTLINE_MAX_POINTS + 1 }, (_, i) => {
      const t = (2 * Math.PI * i) / (OUTLINE_MAX_POINTS + 1);
      return { lat: 6.45 + 0.001 * Math.sin(t), lng: 3.36 + 0.001 * Math.cos(t) };
    });
    expect(outlineProblem(circleish)).toMatch(/200 corners or fewer/);
    expect(outlineProblem(circleish.slice(0, OUTLINE_MAX_POINTS))).toBeNull();
  });
});

describe("typed coordinates", () => {
  it("reads a pair as maps copy it, latitude first", () => {
    expect(parseLatLng("6.5244, 3.3792")).toEqual({ lat: 6.5244, lng: 3.3792 });
    expect(parseLatLng(" 6.5244 3.3792 ")).toEqual({ lat: 6.5244, lng: 3.3792 });
    expect(parseLatLng("6.5244")).toBeNull();
    expect(parseLatLng("north, east")).toBeNull();
    expect(parseLatLng("95, 3")).toBeNull();
  });

  it("reads an outline one corner per line and writes it back", () => {
    const parsed = parseOutline("6.45, 3.36\n\n6.45, 3.361\r\n6.451, 3.361\n6.45, 3.36\n");
    expect(parsed).toEqual({
      points: [
        { lat: 6.45, lng: 3.36 },
        { lat: 6.45, lng: 3.361 },
        { lat: 6.451, lng: 3.361 },
      ],
    });
    expect(parseOutline("6.45, 3.36\nGate A")).toEqual({
      error: "Line 2 isn't a latitude and longitude, like 6.5244, 3.3792",
    });
    if ("points" in parsed)
      expect(formatOutline(parsed.points)).toBe("6.45, 3.36\n6.45, 3.361\n6.451, 3.361");
  });

  it("writes EWKT longitude first, with a closed ring", () => {
    expect(pointEwkt({ lat: 6.5244, lng: 3.3792 })).toBe("SRID=4326;POINT(3.3792 6.5244)");
    expect(
      polygonEwkt([
        { lat: 6.45, lng: 3.36 },
        { lat: 6.45, lng: 3.361 },
        { lat: 6.451, lng: 3.361 },
      ]),
    ).toBe("SRID=4326;POLYGON((3.36 6.45,3.361 6.45,3.361 6.451,3.36 6.45))");
    // Rounded to 6 places, never in exponent form.
    expect(pointEwkt({ lat: 6.123456789, lng: 3.0000001 })).toBe("SRID=4326;POINT(3 6.123457)");
  });

  it("reads the stored outline back from GeoJSON", () => {
    expect(
      pointsFromGeoJson({
        type: "Polygon",
        coordinates: [
          [
            [3.36, 6.45],
            [3.361, 6.45],
            [3.361, 6.451],
            [3.36, 6.45],
          ],
        ],
      }),
    ).toEqual([
      { lat: 6.45, lng: 3.36 },
      { lat: 6.45, lng: 3.361 },
      { lat: 6.451, lng: 3.361 },
    ]);
    expect(pointsFromGeoJson(null)).toBeNull();
    expect(pointsFromGeoJson({ type: "Point", coordinates: [3, 6] })).toBeNull();
  });

  it("formats areas for people", () => {
    expect(formatArea(31_416)).toBe("3.1 ha");
    expect(formatArea(950)).toBe("950 m²");
    expect(formatArea(1_250_000)).toBe("1.25 km²");
  });
});

describe("geofence schema", () => {
  it("takes a pin with the default radius of 100 m", () => {
    const parsed = setGeofenceSchema.parse({
      siteId: SITE,
      mode: "circle",
      lat: "6.4474",
      lng: "3.3611",
      radiusM: "",
    });
    expect(parsed).toEqual({
      siteId: SITE,
      shape: { kind: "circle", centre: { lat: 6.4474, lng: 3.3611 }, radiusM: 100 },
    });
  });

  it("puts each problem under its field", () => {
    const result = setGeofenceSchema.safeParse({
      siteId: SITE,
      mode: "circle",
      lat: "six",
      lng: "3.36",
      radiusM: "10",
    });
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((i) => [i.path[0], i.message]);
    expect(paths).toContainEqual(["radiusM", "The radius must be between 25 and 2,000 metres"]);
    const lat = setGeofenceSchema.safeParse({
      siteId: SITE,
      mode: "circle",
      lat: "six",
      lng: "3.36",
    });
    expect(lat.error!.issues[0]).toMatchObject({
      path: ["lat"],
      message: "Enter the latitude, like 6.5244",
    });
    const abroad = setGeofenceSchema.safeParse({
      siteId: SITE,
      mode: "circle",
      lat: "51.5",
      lng: "-0.12",
    });
    expect(abroad.error!.issues[0]).toMatchObject({
      path: ["lat"],
      message: "The pin must be in Nigeria",
    });
  });

  it("takes an outline and refuses a crossed one", () => {
    const ring = square(150);
    const ok = setGeofenceSchema.parse({
      siteId: SITE,
      mode: "outline",
      outline: formatOutline(ring),
      radiusM: "100",
    });
    expect(ok.shape.kind).toBe("outline");
    const [a, b, c, d] = ring as [LatLng, LatLng, LatLng, LatLng];
    const crossed = setGeofenceSchema.safeParse({
      siteId: SITE,
      mode: "outline",
      outline: formatOutline([a, c, b, d]),
    });
    expect(crossed.error!.issues[0]).toMatchObject({
      path: ["outline"],
      message: "The outline crosses itself. Draw it again around the site",
    });
  });
});

describe("site and checkpoint schemas", () => {
  it("trims names and blanks optional fields", () => {
    expect(
      createSiteSchema.parse({
        clientId: SITE,
        name: "  Apapa Warehouse 3 ",
        address: "",
        state: "Lagos",
        landmark: "",
      }),
    ).toEqual({
      clientId: SITE,
      name: "Apapa Warehouse 3",
      address: null,
      state: "Lagos",
      landmark: null,
    });
    expect(createSiteSchema.safeParse({ clientId: SITE, name: "<b>x</b>" }).success).toBe(false);
    expect(addCheckpointSchema.safeParse({ siteId: SITE, name: "" }).success).toBe(false);
    expect(addCheckpointSchema.parse({ siteId: SITE, name: " Gate A " }).name).toBe("Gate A");
  });

  it("says a site needs an address and a geofence", () => {
    expect(siteNeedsDetails({ address: null, hasGeofence: true })).toBe(true);
    expect(siteNeedsDetails({ address: "4 Wharf Road", hasGeofence: false })).toBe(true);
    expect(siteNeedsDetails({ address: "4 Wharf Road", hasGeofence: true })).toBe(false);
  });

  it("summarises sites with counts only", () => {
    const base = {
      clientId: SITE,
      name: "Apapa Warehouse 3",
      address: null,
      state: null,
      radiusM: 100,
      checkpointCount: 2,
    };
    expect(
      summariseSites([
        { ...base, id: "1", status: "active", geofence: null, needsDetails: true },
        { ...base, id: "2", status: "active", geofence: "circle", needsDetails: false },
        { ...base, id: "3", status: "archived", geofence: null, needsDetails: true },
      ]),
    ).toEqual({ active: 2, archived: 1, withoutGeofence: 1, needsDetails: 1, checkpoints: 4 });
  });
});

describe("QR checkpoint codes", () => {
  function context(role: MutationContext["role"], rpc: ReturnType<typeof vi.fn>): MutationContext {
    return {
      supabase: { rpc } as unknown as SupabaseClient<Database>,
      userId: "user-1",
      organisationId: ORG,
      role,
    };
  }

  it("points at the worker app's scan page, token in the fragment", () => {
    expect(checkpointUrl("https://ops.metaliratech.com/", "ab".repeat(32))).toBe(
      `https://ops.metaliratech.com/m/checkpoint#${"ab".repeat(32)}`,
    );
  });

  it("rotates through the database for owner, admin and ops_manager only, returning no token", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const result = await runMutation(context("ops_manager", rpc), rotateCheckpointQrSpec, {
      checkpointId: CHECKPOINT,
    });
    expect(rpc).toHaveBeenCalledWith("rotate_checkpoint_qr", {
      p_organisation_id: ORG,
      p_checkpoint_id: CHECKPOINT,
    });
    expect(result).toEqual({ id: CHECKPOINT });

    for (const role of ["hr", "finance", "line_manager"] as const) {
      const denied = vi.fn();
      await expect(
        runMutation(context(role, denied), rotateCheckpointQrSpec, { checkpointId: CHECKPOINT }),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(denied).not.toHaveBeenCalled();
    }
  });

  it("explains a retired checkpoint in plain English", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "MLCP1", message: "retired", details: null, hint: null },
    });
    await expect(
      runMutation(context("owner", rpc), rotateCheckpointQrSpec, { checkpointId: CHECKPOINT }),
    ).rejects.toMatchObject({
      code: "invalid",
      message: "A retired checkpoint can't be changed. Add a new one.",
    });
  });
});
