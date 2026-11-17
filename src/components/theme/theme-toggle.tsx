"use client";

import { cn } from "@/lib/utils";

import { THEME_OPTIONS, useThemeChoice } from "./use-theme-choice";

/** Segmented control: Light · Dark · System. */
export function ThemeToggle({ className }: { className?: string }) {
  const [choice, choose] = useThemeChoice();

  return (
    <div
      role="group"
      aria-label="Theme"
      className={cn("inline-flex gap-1 rounded-[10px] bg-surface p-1", className)}
    >
      {THEME_OPTIONS.map(({ value, label, Icon }) => {
        const pressed = choice === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={pressed}
            onClick={() => choose(value)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium",
              pressed ? "bg-background text-foreground ring-1 ring-line" : "text-fg-muted",
            )}
          >
            <Icon className="size-4" strokeWidth={1.75} aria-hidden />
            {label}
          </button>
        );
      })}
    </div>
  );
}
