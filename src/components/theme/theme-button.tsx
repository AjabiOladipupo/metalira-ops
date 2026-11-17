"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import type { ThemeChoice } from "./theme";
import { THEME_OPTIONS, useThemeChoice } from "./use-theme-choice";

/**
 * Compact theme switcher for page headers: one 44px icon button showing the current choice,
 * opening Light · Dark · System. The choice is saved on the device, as with ThemeToggle.
 */
export function ThemeButton({ className }: { className?: string }) {
  const [choice, choose] = useThemeChoice();
  const current = THEME_OPTIONS.find((o) => o.value === choice) ?? THEME_OPTIONS[2]!;
  const CurrentIcon = current.Icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Theme: ${current.label}`}
          data-testid="theme-button"
          className={cn(
            "inline-flex size-11 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-surface hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
            className,
          )}
        >
          <CurrentIcon strokeWidth={1.75} className="size-5" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuLabel className="type-label text-fg-muted">Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={choice}
          onValueChange={(value) => choose(value as ThemeChoice)}
        >
          {THEME_OPTIONS.map(({ value, label, Icon }) => (
            <DropdownMenuRadioItem key={value} value={value} className="min-h-11">
              <Icon strokeWidth={1.75} aria-hidden />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
