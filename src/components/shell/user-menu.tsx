"use client";

import { LogOut, User } from "lucide-react";
import { useTransition } from "react";

import { ThemeToggle } from "@/components/theme/theme-toggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function initials(name: string | null, email: string): string {
  const source = name?.trim() || email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const letters =
    parts.length > 1 ? `${parts[0]?.[0]}${parts[1]?.[0]}` : (parts[0] ?? "").slice(0, 2);
  return letters.toUpperCase();
}

export interface UserMenuProps {
  name: string | null;
  email: string;
  roleLabel: string | null;
  signOutAction: () => Promise<void>;
}

/** Avatar initials opening: who is signed in, their role, the theme choice and sign out. */
export function UserMenu({ name, email, roleLabel, signOutAction }: UserMenuProps) {
  const [pending, startTransition] = useTransition();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          className="flex size-9 items-center justify-center rounded-full bg-action text-[13px] font-semibold text-on-action"
        >
          {initials(name, email) || <User strokeWidth={1.75} className="size-[18px]" aria-hidden />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto max-w-80 min-w-64">
        <DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
          <span className="truncate text-sm font-semibold text-foreground">{name ?? email}</span>
          {name ? <span className="truncate text-xs text-fg-muted">{email}</span> : null}
          {roleLabel ? <span className="text-xs text-fg-muted">{roleLabel}</span> : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5">
          <span className="mb-2 block type-label text-fg-muted">Theme</span>
          <ThemeToggle />
        </div>
        <DropdownMenuSeparator />
        {/* Called directly: a submit button inside the menu would unmount before submitting. */}
        <DropdownMenuItem
          disabled={pending}
          onSelect={() => startTransition(() => signOutAction())}
        >
          <LogOut strokeWidth={1.75} />
          {pending ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Shown while the session loads: the same button, with nothing behind it yet. */
export function UserMenuFallback() {
  return (
    <span
      aria-hidden
      className="flex size-9 items-center justify-center rounded-full bg-action text-on-action"
    >
      <User strokeWidth={1.75} className="size-[18px]" />
    </span>
  );
}
