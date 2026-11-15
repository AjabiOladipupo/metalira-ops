"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

import { applyThemeChoice, readThemeChoice, type ThemeChoice } from "./theme";

const OPTIONS: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

/** Segmented control: Light · Dark · System. */
export function ThemeToggle({ className }: { className?: string }) {
  const [choice, setChoice] = useState<ThemeChoice>("system");

  useEffect(() => {
    // Sync with the value the pre-paint script already applied.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setChoice(readThemeChoice());
  }, []);

  useEffect(() => {
    if (choice !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyThemeChoice("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [choice]);

  return (
    <div
      role="group"
      aria-label="Theme"
      className={cn("inline-flex gap-1 rounded-[10px] bg-surface p-1", className)}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const pressed = choice === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={pressed}
            onClick={() => {
              setChoice(value);
              applyThemeChoice(value);
            }}
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
