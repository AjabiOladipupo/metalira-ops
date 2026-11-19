"use client";

import { Bell, Menu, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { LogoMark } from "@/components/logo";
import { ThemeButton } from "@/components/theme/theme-button";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/**
 * Company switcher, site filter, search, theme, notifications and user menu. The session-dependent
 * parts (`menuNav`, `orgSwitcher`, `userMenu`) are server-rendered slots that stream in behind
 * their own Suspense boundaries, so the bar itself stays in the static shell.
 */
export function TopBar({
  menuNav,
  orgSwitcher,
  userMenu,
  planCard,
}: {
  menuNav: React.ReactNode;
  orgSwitcher: React.ReactNode;
  userMenu: React.ReactNode;
  planCard: React.ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3.5 lg:px-8">
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetTrigger asChild>
          <Button variant="outline" size="icon" aria-label="Open menu" className="lg:hidden">
            <Menu strokeWidth={1.75} className="size-5" />
          </Button>
        </SheetTrigger>
        <SheetContent
          side="left"
          className="w-72 gap-4 overflow-y-auto px-3 py-5"
          // Close after following any link in the menu (the links are a server-rendered slot).
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("a")) setMenuOpen(false);
          }}
        >
          <SheetTitle className="sr-only">Menu</SheetTitle>
          <Link
            href="/app"
            aria-label="Metalira Ops home"
            className="flex items-center gap-2.5 px-3 py-1 text-foreground no-underline"
          >
            <LogoMark />
            <span className="font-display text-lg font-medium">
              Metalira <b className="font-bold">Ops</b>
            </span>
          </Link>
          {menuNav}
          {planCard}
        </SheetContent>
      </Sheet>

      {/* On phones the company name shrinks (and truncates) so the icons stay on the first row. */}
      <div className="flex min-w-0 flex-1 md:flex-none">{orgSwitcher}</div>

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

      <label className="order-last flex h-10 min-w-0 basis-full items-center gap-2 rounded-lg bg-surface px-3 text-fg-muted md:order-none md:grow md:basis-60">
        <Search strokeWidth={1.75} className="size-4 shrink-0" aria-hidden />
        <span className="sr-only">Search</span>
        <input
          type="search"
          placeholder="Search workers, sites, invoices"
          className="min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-fg-muted"
        />
      </label>

      <div className="ml-auto flex shrink-0 items-center gap-3 md:ml-0">
        <ThemeButton className="-mx-1.5" />
        <Button variant="outline" size="icon" aria-label="Notifications">
          <Bell strokeWidth={1.75} className="size-[18px]" />
        </Button>
        {userMenu}
      </div>
    </header>
  );
}

/** Same footprint as the company switcher, while the session loads. */
export function OrgSwitcherSkeleton() {
  return <span aria-hidden className="h-10 w-40 max-w-full rounded-lg border border-line" />;
}
