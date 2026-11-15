"use client";

import { Bell, ChevronDown, LogOut, Menu, Search, User } from "lucide-react";
import Link from "next/link";
import { Suspense, useState } from "react";

import { LogoMark } from "@/components/logo";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

import { PlanCard } from "./app-sidebar";
import { NavLinks } from "./nav-links";

/**
 * Company switcher, site filter, search, notifications and user menu.
 * Placeholders until sign-in (slice 0.4) provides real organisations and sites.
 */
export function TopBar() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3.5 lg:px-8">
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetTrigger asChild>
          <Button variant="outline" size="icon" aria-label="Open menu" className="lg:hidden">
            <Menu strokeWidth={1.75} className="size-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-72 gap-4 overflow-y-auto px-3 py-5">
          <SheetTitle className="sr-only">Menu</SheetTitle>
          <Link
            href="/app"
            onClick={() => setMenuOpen(false)}
            aria-label="Metalira Ops home"
            className="flex items-center gap-2.5 px-3 py-1 text-foreground no-underline"
          >
            <LogoMark />
            <span className="font-display text-lg font-medium">
              Metalira <b className="font-bold">Ops</b>
            </span>
          </Link>
          <Suspense fallback={null}>
            <NavLinks onNavigate={() => setMenuOpen(false)} />
          </Suspense>
          <PlanCard />
        </SheetContent>
      </Sheet>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="max-w-[50vw] min-w-0 sm:max-w-none">
            <span className="truncate">Your company</span>
            <ChevronDown strokeWidth={1.75} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel>Companies</DropdownMenuLabel>
          <DropdownMenuItem disabled>Your company</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled>Companies appear after sign-in</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="hidden md:block">
        <Select defaultValue="all">
          <SelectTrigger aria-label="Site" className="min-w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sites</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <label className="order-last flex h-10 min-w-0 basis-full items-center gap-2 rounded-md bg-surface px-3 text-fg-muted md:order-none md:grow md:basis-60">
        <Search strokeWidth={1.75} className="size-4 shrink-0" aria-hidden />
        <span className="sr-only">Search</span>
        <input
          type="search"
          placeholder="Search workers, sites, invoices"
          className="min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-fg-muted"
        />
      </label>

      <div className="ml-auto flex items-center gap-3 md:ml-0">
        <Button variant="outline" size="icon" aria-label="Notifications">
          <Bell strokeWidth={1.75} className="size-[18px]" />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Account menu"
              className="flex size-9 items-center justify-center rounded-full bg-action text-on-action"
            >
              <User strokeWidth={1.75} className="size-[18px]" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-64">
            <DropdownMenuLabel>Not signed in</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5">
              <span className="mb-2 block type-label text-fg-muted">Theme</span>
              <ThemeToggle />
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>
              <LogOut strokeWidth={1.75} />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
