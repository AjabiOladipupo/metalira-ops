"use client";

import "leaflet/dist/leaflet.css";

import L from "leaflet";
import { useEffect, useRef } from "react";

import { DEFAULT_MAP_CENTRE, type LatLng } from "@/lib/geofence";

/**
 * The geofence map (slice 2.2): Leaflet with MapTiler tiles. Loaded only by the geofence editor,
 * through `next/dynamic` with `ssr: false`, and only when NEXT_PUBLIC_MAPTILER_KEY is set, so no
 * other page (and no test run without the key) downloads Leaflet or calls MapTiler.
 *
 * It draws what the editor holds and reports taps: in circle mode a tap moves the pin, in outline
 * mode it adds a corner. The typed coordinates in the editor stay the source of truth.
 */

export interface GeofenceMapProps {
  apiKey: string;
  mode: "circle" | "outline";
  centre: LatLng | null;
  radiusM: number | null;
  outline: readonly LatLng[];
  onPick?: (point: LatLng) => void;
}

const ATTRIBUTION =
  '<a href="https://www.maptiler.com/copyright/" target="_blank" rel="noreferrer">&copy; MapTiler</a> ' +
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">&copy; OpenStreetMap contributors</a>';

function tiles(style: "streets-v2" | "hybrid", apiKey: string, ext: "png" | "jpg") {
  return L.tileLayer(
    `https://api.maptiler.com/maps/${style}/{z}/{x}/{y}.${ext}?key=${encodeURIComponent(apiKey)}`,
    {
      tileSize: 512,
      zoomOffset: -1,
      minZoom: 1,
      maxZoom: 20,
      attribution: ATTRIBUTION,
      crossOrigin: true,
    },
  );
}

function signalColour(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--signal").trim();
  return value || "#6d4cff";
}

export default function GeofenceMap({
  apiKey,
  mode,
  centre,
  radiusM,
  outline,
  onPick,
}: GeofenceMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const shapes = useRef<L.LayerGroup | null>(null);
  const pick = useRef(onPick);
  const fitted = useRef(false);

  useEffect(() => {
    pick.current = onPick;
  }, [onPick]);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const start = centre ?? outline[0] ?? DEFAULT_MAP_CENTRE;
    const instance = L.map(el, {
      center: [start.lat, start.lng],
      zoom: centre || outline.length ? 17 : 12,
      scrollWheelZoom: false,
    });
    const streets = tiles("streets-v2", apiKey, "png").addTo(instance);
    const satellite = tiles("hybrid", apiKey, "jpg");
    L.control.layers({ Map: streets, Satellite: satellite }, undefined, { position: "topright" }).addTo(instance);
    shapes.current = L.layerGroup().addTo(instance);
    instance.on("click", (event: L.LeafletMouseEvent) => {
      pick.current?.({ lat: event.latlng.lat, lng: event.latlng.lng });
    });
    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
      shapes.current = null;
      fitted.current = false;
    };
    // The map is made once per key; shapes follow the props below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  useEffect(() => {
    const instance = map.current;
    const group = shapes.current;
    if (!instance || !group) return;
    group.clearLayers();
    const colour = signalColour();
    const style = { color: colour, weight: 2, fillColor: colour, fillOpacity: 0.12 };
    let bounds: L.LatLngBounds | null = null;

    if (mode === "circle" && centre) {
      const circle = L.circle([centre.lat, centre.lng], { ...style, radius: radiusM ?? 100 });
      circle.addTo(group);
      L.circleMarker([centre.lat, centre.lng], {
        radius: 6,
        color: colour,
        weight: 2,
        fillColor: colour,
        fillOpacity: 1,
      }).addTo(group);
      bounds = circle.getBounds();
    }
    if (mode === "outline" && outline.length > 0) {
      const corners = outline.map((p) => L.latLng(p.lat, p.lng));
      const shape = corners.length >= 3 ? L.polygon(corners, style) : L.polyline(corners, style);
      shape.addTo(group);
      for (const corner of corners) {
        L.circleMarker(corner, {
          radius: 4,
          color: colour,
          weight: 2,
          fillColor: "#ffffff",
          fillOpacity: 1,
        }).addTo(group);
      }
      bounds = shape.getBounds();
    }
    if (bounds && !fitted.current && bounds.isValid()) {
      instance.fitBounds(bounds, { padding: [24, 24], maxZoom: 18 });
      fitted.current = true;
    }
  }, [mode, centre, radiusM, outline]);

  return (
    <div
      ref={container}
      role="application"
      aria-label={
        onPick
          ? mode === "circle"
            ? "Map. Tap the site to move the pin."
            : "Map. Tap each corner of the site in turn."
          : "Map of the geofence"
      }
      className="z-0 h-[320px] w-full overflow-hidden rounded-xl border border-line md:h-[420px]"
    />
  );
}
