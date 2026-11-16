"use client";

import { Banknote, Clock, House, Plane, UserRound, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { workerMessages } from "@/lib/messages/worker";
import { cn } from "@/lib/utils";
import { WORKER_NAV, activeWorkerNav, type WorkerNavKey } from "@/lib/worker-nav";

const ICONS: Record<WorkerNavKey, LucideIcon> = {
  home: House,
  clock: Clock,
  leave: Plane,
  payslips: Banknote,
  me: UserRound,
};

/**
 * The worker app's bottom nav: five items, 20px icons, the active one in signal violet
 * (DESIGN_SYSTEM.md). Fixed to the bottom of the phone column, clear of the home indicator.
 */
export function BottomNav() {
  const active = activeWorkerNav(usePathname());
  return (
    <nav
      aria-label={workerMessages.nav.label}
      className="fixed inset-x-0 bottom-0 z-20 flex justify-center border-t border-line bg-background pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="m-0 grid w-full max-w-[430px] list-none grid-cols-5 p-0">
        {WORKER_NAV.map((item) => {
          const Icon = ICONS[item.key];
          const current = item.key === active;
          return (
            <li key={item.key} className="min-w-0">
              <Link
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "flex h-16 flex-col items-center justify-center gap-1 text-xs font-medium no-underline",
                  current ? "text-signal" : "text-fg-muted hover:text-foreground",
                )}
              >
                <Icon strokeWidth={1.75} className="size-5" aria-hidden />
                <span className="truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
