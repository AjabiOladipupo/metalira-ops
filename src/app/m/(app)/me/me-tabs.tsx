"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { workerMessages } from "@/lib/messages/worker";
import { cn } from "@/lib/utils";

const copy = workerMessages.me;

const TABS = [
  { key: "profile", label: copy.profileTab, tabId: "me-profile-tab", panelId: "me-profile-panel" },
  { key: "queries", label: copy.queriesTab, tabId: "me-queries-tab", panelId: "me-queries-panel" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

/**
 * The Profile and Queries tabs on Me (WkProfile board). The profile panel is rendered on the
 * server and passed in as children, so it stays mounted (its links and sign-out form intact)
 * while Queries is shown. The Queries panel (slice 4.6) is rendered on the server too: an empty
 * state, or a link to /m/queries with the open count.
 * Keyboard: arrow keys, Home and End move between tabs (WAI-ARIA tabs, automatic activation).
 */
export function MeTabs({ children, queries }: { children: ReactNode; queries: ReactNode }) {
  const [selected, setSelected] = useState<TabKey>("profile");
  const refs = useRef<Record<TabKey, HTMLButtonElement | null>>({ profile: null, queries: null });

  function select(index: number) {
    const tab = TABS[(index + TABS.length) % TABS.length];
    if (!tab) return;
    setSelected(tab.key);
    refs.current[tab.key]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowRight") select(index + 1);
    else if (event.key === "ArrowLeft") select(index - 1);
    else if (event.key === "Home") select(0);
    else if (event.key === "End") select(TABS.length - 1);
    else return;
    event.preventDefault();
  }

  return (
    <>
      <div role="tablist" aria-label={copy.tabs} className="flex border-b border-line px-4">
        {TABS.map((tab, index) => {
          const isSelected = tab.key === selected;
          return (
            <button
              key={tab.key}
              ref={(el) => {
                refs.current[tab.key] = el;
              }}
              type="button"
              role="tab"
              id={tab.tabId}
              aria-selected={isSelected}
              aria-controls={tab.panelId}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => setSelected(tab.key)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                "-mb-px h-12 flex-1 border-b-2 bg-transparent text-[15px] font-semibold",
                isSelected
                  ? "border-foreground text-foreground"
                  : "border-transparent text-fg-muted",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id="me-profile-panel"
        aria-labelledby="me-profile-tab"
        hidden={selected !== "profile"}
        className="flex flex-col gap-[18px] px-4 pt-3 pb-4"
      >
        {children}
      </div>

      <div
        role="tabpanel"
        id="me-queries-panel"
        aria-labelledby="me-queries-tab"
        hidden={selected !== "queries"}
        // The panel itself takes focus when it holds only the empty state (WAI-ARIA tabs pattern).
        tabIndex={0}
        className="px-4 pt-3 pb-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
      >
        {queries}
      </div>
    </>
  );
}
