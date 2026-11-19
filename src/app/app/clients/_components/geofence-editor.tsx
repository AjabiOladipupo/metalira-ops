"use client";

import dynamic from "next/dynamic";
import { useActionState, useCallback, useId, useMemo, useState } from "react";

import { Field, FormAlert, SubmitButton } from "@/components/form";
import { Button } from "@/components/ui/button";
import {
  RADIUS_DEFAULT_M,
  RADIUS_MAX_M,
  RADIUS_MIN_M,
  circleAreaM2,
  formatArea,
  formatOutline,
  insideNigeria,
  outlineProblem,
  parseDegrees,
  parseOutline,
  polygonAreaM2,
  radiusProblem,
  roundCoordinate,
  type LatLng,
} from "@/lib/geofence";
import { cn } from "@/lib/utils";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import { setGeofenceAction } from "@/server/sites/actions";

import { fieldValue } from "../../_company/form-footer";

/** Leaflet and its CSS load only here, only in the browser, and only with a MapTiler key. */
const GeofenceMap = dynamic(() => import("./geofence-map"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[320px] items-center justify-center rounded-xl border border-line bg-surface text-sm text-fg-muted md:h-[420px]">
      Loading map…
    </div>
  ),
});

const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY ?? "";

export interface GeofenceValues {
  mode: "circle" | "outline";
  centre: LatLng | null;
  radiusM: number;
  outline: LatLng[] | null;
}

type Mode = GeofenceValues["mode"];

function ModeChoice({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  const name = useId();
  const options: { value: Mode; label: string; hint: string }[] = [
    { value: "circle", label: "Pin and radius", hint: "Best on a phone at the site." },
    { value: "outline", label: "Draw an outline", hint: "For a compound or an estate." },
  ];
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="mb-1.5 p-0 text-[13px] font-medium">Shape</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              "flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5",
              mode === o.value ? "border-foreground" : "border-line",
            )}
          >
            <input
              type="radio"
              name="mode"
              value={o.value}
              checked={mode === o.value}
              onChange={() => onChange(o.value)}
              className="mt-0.5 size-5 accent-[var(--action)]"
              aria-describedby={`${name}-${o.value}`}
            />
            <span className="flex flex-col">
              <span className="text-[15px] font-medium">{o.label}</span>
              <span id={`${name}-${o.value}`} className="text-xs text-fg-muted">
                {o.hint}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function located(point: LatLng): { lat: string; lng: string } {
  return { lat: String(roundCoordinate(point.lat)), lng: String(roundCoordinate(point.lng)) };
}

/**
 * Sets a site's geofence: a pin with a radius (default 100 m), or a drawn outline. Coordinates can
 * be typed, taken from the phone ("Use my location") or picked on the map when the MapTiler key is
 * set. Everything is checked again on the server and in the database.
 */
export function GeofenceEditor({ siteId, initial }: { siteId: string; initial: GeofenceValues }) {
  const [state, action] = useActionState<CompanyFormState, FormData>(setGeofenceAction, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const typed = (name: string, saved: string) => fieldValue(state, name, saved);

  const [mode, setMode] = useState<Mode>((typed("mode", initial.mode) as Mode) || initial.mode);
  const [lat, setLat] = useState(
    typed("lat", initial.centre ? String(roundCoordinate(initial.centre.lat)) : ""),
  );
  const [lng, setLng] = useState(
    typed("lng", initial.centre ? String(roundCoordinate(initial.centre.lng)) : ""),
  );
  const [radius, setRadius] = useState(typed("radiusM", String(initial.radiusM)));
  const [outlineText, setOutlineText] = useState(
    typed("outline", initial.outline ? formatOutline(initial.outline) : ""),
  );
  const [locating, setLocating] = useState(false);
  const [locateNote, setLocateNote] = useState<string | null>(null);
  const outlineId = useId();

  const centre = useMemo<LatLng | null>(() => {
    const a = parseDegrees(lat);
    const b = parseDegrees(lng);
    return a === null || b === null ? null : { lat: a, lng: b };
  }, [lat, lng]);
  const radiusM = /^\d{1,5}$/.test(radius.trim()) ? Number.parseInt(radius.trim(), 10) : null;
  const parsedOutline = useMemo(() => parseOutline(outlineText), [outlineText]);
  const corners = "points" in parsedOutline ? parsedOutline.points : [];

  const addCorner = useCallback((p: LatLng) => {
    setOutlineText((text) => {
      const line = `${roundCoordinate(p.lat)}, ${roundCoordinate(p.lng)}`;
      return text.trim() ? `${text.trimEnd()}\n${line}` : line;
    });
  }, []);

  const pick = useCallback(
    (p: LatLng) => {
      if (mode === "circle") {
        const next = located(p);
        setLat(next.lat);
        setLng(next.lng);
      } else {
        addCorner(p);
      }
    },
    [mode, addCorner],
  );

  function locateMe() {
    if (!("geolocation" in navigator)) {
      setLocateNote("This browser can't share a location. Type the coordinates instead.");
      return;
    }
    setLocating(true);
    setLocateNote(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        pick(p);
        const accuracy = Math.round(pos.coords.accuracy);
        setLocateNote(
          `${mode === "circle" ? "Pin set" : "Corner added"} to within ${accuracy.toLocaleString("en-NG")} m.` +
            (accuracy > 50
              ? " Step outside or wait a moment, then try again for a closer fix."
              : ""),
        );
      },
      (error) => {
        setLocating(false);
        setLocateNote(
          error.code === error.PERMISSION_DENIED
            ? "Location is blocked for this site. Allow it in the browser settings, or type the coordinates."
            : "Your location couldn't be found. Try again outside, or type the coordinates.",
        );
      },
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  }

  // A live check as the person types; the server says the final word.
  let summary: string | null = null;
  let problem: string | null = null;
  if (mode === "circle") {
    if (radiusM === null) problem = "Enter the radius in whole metres";
    else problem = radiusProblem(radiusM);
    if (!problem && centre && !insideNigeria(centre)) problem = "The pin must be in Nigeria";
    if (!problem && centre && radiusM !== null) {
      summary = `${radiusM.toLocaleString("en-NG")} m circle · ${formatArea(circleAreaM2(radiusM))}`;
    }
  } else if ("error" in parsedOutline) {
    problem = parsedOutline.error;
  } else if (corners.length > 0) {
    problem = outlineProblem(corners);
    if (!problem) {
      summary = `Outline · ${corners.length.toLocaleString("en-NG")} corners · ${formatArea(polygonAreaM2(corners))}`;
    }
  }

  return (
    <form
      action={action}
      noValidate
      aria-label="Geofence"
      className="flex flex-col gap-4 rounded-xl bg-surface p-4 sm:p-5"
    >
      <input type="hidden" name="siteId" value={siteId} />
      <ModeChoice mode={mode} onChange={setMode} />

      {MAPTILER_KEY ? (
        <GeofenceMap
          apiKey={MAPTILER_KEY}
          mode={mode}
          centre={centre}
          radiusM={radiusM}
          outline={corners}
          onPick={pick}
        />
      ) : (
        <p className="m-0 rounded-lg border border-line bg-background px-3 py-2.5 text-sm text-fg-muted">
          The map isn&apos;t available here. Use your location at the site, or type the coordinates
          from a map app.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          className="h-11 px-4"
          onClick={locateMe}
          disabled={locating}
        >
          {locating
            ? "Finding you…"
            : mode === "circle"
              ? "Use my location"
              : "Add my location as a corner"}
        </Button>
        <p role="status" className="m-0 text-sm text-fg-muted">
          {locateNote}
        </p>
      </div>

      {mode === "circle" ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,160px),1fr))] items-start gap-4">
          <Field
            label="Latitude"
            name="lat"
            inputMode="decimal"
            autoComplete="off"
            placeholder="6.5244"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            error={errors?.lat}
          />
          <Field
            label="Longitude"
            name="lng"
            inputMode="decimal"
            autoComplete="off"
            placeholder="3.3792"
            value={lng}
            onChange={(e) => setLng(e.target.value)}
            error={errors?.lng}
          />
          <Field
            label="Radius (metres)"
            name="radiusM"
            inputMode="numeric"
            autoComplete="off"
            value={radius}
            onChange={(e) => setRadius(e.target.value)}
            hint={`${RADIUS_MIN_M} to ${RADIUS_MAX_M.toLocaleString("en-NG")}. ${RADIUS_DEFAULT_M} m covers most compounds.`}
            error={errors?.radiusM}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <input type="hidden" name="radiusM" value={radius} />
          <label htmlFor={outlineId} className="text-[13px] font-medium">
            Corners
          </label>
          <textarea
            id={outlineId}
            name="outline"
            rows={6}
            value={outlineText}
            onChange={(e) => setOutlineText(e.target.value)}
            spellCheck={false}
            placeholder={"6.5244, 3.3792\n6.5251, 3.3801\n6.5240, 3.3809"}
            aria-invalid={errors?.outline ? true : undefined}
            aria-describedby={`${outlineId}-note`}
            className="w-full min-w-0 rounded-lg border border-line bg-background px-3 py-2.5 font-mono text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal aria-invalid:border-foreground"
          />
          <p
            id={`${outlineId}-note`}
            className={cn(
              "m-0 text-xs",
              errors?.outline ? "font-medium text-foreground" : "text-fg-muted",
            )}
          >
            {errors?.outline ??
              "One corner per line, latitude first, in order around the site. Tap the map to add one."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-10 px-3"
              disabled={corners.length === 0}
              onClick={() => setOutlineText(formatOutline(corners.slice(0, -1)))}
            >
              Undo last corner
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-10 px-3"
              disabled={outlineText.trim() === ""}
              onClick={() => setOutlineText("")}
            >
              Clear outline
            </Button>
          </div>
        </div>
      )}

      <p className="m-0 text-sm" data-testid="geofence-preview" aria-live="polite">
        {problem ? <span className="text-fg-muted">{problem}.</span> : summary}
      </p>

      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Saving…" className="w-auto px-5">
          Save geofence
        </SubmitButton>
        <p role="status" className="m-0 text-sm text-fg-muted">
          {state?.ok ? state.message : null}
        </p>
      </div>
    </form>
  );
}
