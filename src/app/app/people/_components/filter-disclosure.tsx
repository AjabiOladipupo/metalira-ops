"use client";

import { SlidersHorizontal } from "lucide-react";
import { useId, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";

const WIDE = "(min-width: 1024px)";

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * Shows or hides the filters. Open from the start on wide screens or while a filter is on; on a
 * phone it starts closed so the list stays above the fold. Once toggled, the choice sticks.
 */
export function FilterDisclosure({
  active,
  clear,
  children,
}: {
  active: number;
  clear?: React.ReactNode;
  children: React.ReactNode;
}) {
  const id = useId();
  const wide = useSyncExternalStore(
    subscribe,
    () => window.matchMedia(WIDE).matches,
    () => false,
  );
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? (active > 0 || wide);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          className="h-10 rounded-lg"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setToggled(!open)}
        >
          <SlidersHorizontal strokeWidth={1.75} aria-hidden className="size-4" />
          {active > 0 ? `Filters (${active})` : "Filters"}
        </Button>
        {clear}
      </div>
      <div id={id} hidden={!open}>
        {children}
      </div>
    </div>
  );
}
