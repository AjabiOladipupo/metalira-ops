"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { activeNavHref, NAV } from "@/lib/nav";
import { cn } from "@/lib/utils";

import { NAV_ICONS } from "./nav-icons";

/** Sidebar links grouped as Home · Workforce · Payroll · Business · Revenue · Settings. */
export function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const active = activeNavHref(pathname);

  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.map((group) => (
        <div key={group.label ?? "top"} className="flex flex-col gap-0.5">
          {group.label ? (
            <div className="px-3 pt-3.5 pb-1.5 type-label text-fg-muted">{group.label}</div>
          ) : null}
          {group.items.map((item) => {
            const Icon = NAV_ICONS[item.icon];
            const isActive = item.href === active;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium no-underline transition-colors",
                  isActive
                    ? "bg-surface text-signal"
                    : "text-foreground hover:bg-surface hover:text-foreground",
                )}
              >
                <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden />
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
