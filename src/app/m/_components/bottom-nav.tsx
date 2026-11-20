"use client";

import { Banknote, Clock, House, Plane, UserRound, type LucideIcon } from "lucide-react";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";

import { workerMessages } from "@/lib/messages/worker";
import { cn } from "@/lib/utils";
import { activeWorkerNav, workerNavFor, type WorkerNavKey } from "@/lib/worker-nav";

const ICONS: Record<WorkerNavKey, LucideIcon> = {
  home: House,
  clock: Clock,
  leave: Plane,
  payslips: Banknote,
  me: UserRound,
};

/**
 * An item's icon and label. While its navigation is pending (a tap on a slow connection, before
 * the next screen arrives) it turns signal violet and shows a thin bar at the top edge, so the
 * tap is acknowledged at once. Fixed-size and always rendered, so nothing shifts.
 */
function ItemContent({ Icon, label }: { Icon: LucideIcon; label: string }) {
  const { pending } = useLinkStatus();
  return (
    <>
      <span
        aria-hidden
        className={cn(
          "absolute inset-x-3 top-0 h-0.5 rounded-full bg-signal transition-opacity duration-150",
          pending ? "opacity-100" : "opacity-0",
        )}
      />
      <Icon strokeWidth={1.75} className={cn("size-5", pending && "text-signal")} aria-hidden />
      <span className={cn("truncate", pending && "text-signal")}>{label}</span>
    </>
  );
}

/**
 * The worker app's bottom nav: five items, 20px icons, the active one in signal violet
 * (DESIGN_SYSTEM.md). Fixed to the bottom of the phone column, clear of the home indicator.
 * Clock is left out when the company has Shifts off (slice 3.0), leaving four.
 */
export function BottomNav({ shiftsEnabled = true }: { shiftsEnabled?: boolean }) {
  const active = activeWorkerNav(usePathname());
  const items = workerNavFor(shiftsEnabled);
  return (
    <nav
      aria-label={workerMessages.nav.label}
      className="fixed inset-x-0 bottom-0 z-20 flex justify-center border-t border-line bg-background pb-[env(safe-area-inset-bottom)]"
    >
      <ul
        className={cn(
          "m-0 grid w-full max-w-[430px] list-none p-0",
          items.length === 5 ? "grid-cols-5" : "grid-cols-4",
        )}
      >
        {items.map((item) => {
          const current = item.key === active;
          return (
            <li key={item.key} className="min-w-0">
              <Link
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "relative flex h-16 flex-col items-center justify-center gap-1 text-xs font-medium no-underline",
                  current ? "text-signal" : "text-fg-muted hover:text-foreground",
                )}
              >
                <ItemContent Icon={ICONS[item.key]} label={item.label} />
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
