"use client";

import { useState } from "react";

import { WEEKDAYS } from "@/lib/leave/entitlements";
import { cn } from "@/lib/utils";

/**
 * The worker's usual working days (slice 4.4): the company's week, or days of their own. Leave
 * counts working days on them beyond the worker's last rostered day. Sends `usualWorkDays` as
 * "company" or "1,2,3,4,5"; the server checks it again.
 */
export function WorkWeekField({
  saved,
  companyLabel,
  error,
}: {
  saved: number[] | null;
  /** "Mon to Fri": the company's week, for the first option's label. */
  companyLabel: string;
  error?: string;
}) {
  const [own, setOwn] = useState(saved !== null);
  const [days, setDays] = useState<number[]>(saved ?? [1, 2, 3, 4, 5]);
  const toggle = (iso: number) =>
    setDays((current) =>
      current.includes(iso) ? current.filter((d) => d !== iso) : [...current, iso].sort((a, b) => a - b),
    );
  return (
    <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
      <legend className="mb-2 text-[13px] font-medium">Usual working days</legend>
      <input type="hidden" name="usualWorkDays" value={own ? days.join(",") : "company"} />
      <label className="flex min-h-11 items-center gap-3">
        <input
          type="radio"
          name="usualWorkDaysChoice"
          checked={!own}
          onChange={() => setOwn(false)}
          className="size-4 accent-[var(--signal)]"
        />
        <span className="text-sm">The company&apos;s week ({companyLabel})</span>
      </label>
      <label className="flex min-h-11 items-center gap-3">
        <input
          type="radio"
          name="usualWorkDaysChoice"
          checked={own}
          onChange={() => setOwn(true)}
          className="size-4 accent-[var(--signal)]"
        />
        <span className="text-sm">Days of their own</span>
      </label>
      {own ? (
        <div role="group" aria-label="Working days" className="flex flex-wrap gap-2">
          {WEEKDAYS.map((d) => (
            <button
              key={d.iso}
              type="button"
              aria-pressed={days.includes(d.iso)}
              onClick={() => toggle(d.iso)}
              className={cn(
                "h-11 min-w-12 rounded-lg border px-3 text-sm font-medium",
                days.includes(d.iso)
                  ? "border-foreground bg-foreground text-background"
                  : "border-line bg-background text-foreground",
              )}
            >
              {d.short}
            </button>
          ))}
        </div>
      ) : null}
      <p className={error ? "m-0 text-xs font-medium" : "m-0 text-xs text-fg-muted"}>
        {error ?? "Leave counts these days once the roster runs out. Rostered shifts always count."}
      </p>
    </fieldset>
  );
}
