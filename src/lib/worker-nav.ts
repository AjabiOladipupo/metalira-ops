import { workerMessages } from "@/lib/messages/worker";

/**
 * The worker app's bottom nav (DESIGN_SYSTEM.md: Home, Clock, Leave, Payslips, Me). Pure, so
 * the active-item rule is unit tested.
 */

export type WorkerNavKey = "home" | "clock" | "leave" | "payslips" | "me";

export interface WorkerNavItem {
  key: WorkerNavKey;
  href: string;
  label: string;
}

const copy = workerMessages.nav;

export const WORKER_NAV: readonly WorkerNavItem[] = [
  { key: "home", href: "/m", label: copy.home },
  { key: "clock", href: "/m/clock", label: copy.clock },
  { key: "leave", href: "/m/leave", label: copy.leave },
  { key: "payslips", href: "/m/payslips", label: copy.payslips },
  { key: "me", href: "/m/me", label: copy.me },
];

/**
 * Items that need the company's Shifts switch (slice 3.0): Clock is hidden when it is off. My
 * shifts is a Home tile, not a nav item, and is hidden the same way.
 */
export const SHIFTS_ONLY: readonly WorkerNavKey[] = ["clock"];

/** The bottom nav for a company with Shifts on or off. */
export function workerNavFor(shiftsEnabled: boolean): readonly WorkerNavItem[] {
  return shiftsEnabled ? WORKER_NAV : WORKER_NAV.filter((i) => !SHIFTS_ONLY.includes(i.key));
}

/** The nav item a path belongs to: Home only on /m itself, the others on their own subtree. */
export function activeWorkerNav(pathname: string): WorkerNavKey | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === "/m") return "home";
  const item = WORKER_NAV.find(
    (i) => i.key !== "home" && (path === i.href || path.startsWith(`${i.href}/`)),
  );
  return item?.key ?? null;
}
