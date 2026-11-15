import Link from "next/link";
import { Suspense } from "react";

import { Logo } from "@/components/logo";

import { NavLinks } from "./nav-links";

/** Desktop sidebar (lg and up). On smaller screens the same links live in the mobile menu. */
export function AppSidebar() {
  return (
    <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r border-line px-3 py-5 lg:flex">
      <Link href="/app" aria-label="Metalira Ops home" className="px-3 py-1 no-underline">
        <Logo />
      </Link>
      <Suspense fallback={null}>
        <NavLinks />
      </Suspense>
      <PlanCard />
    </aside>
  );
}

export function PlanCard() {
  return (
    <div className="mt-auto flex flex-col gap-1 rounded-lg border border-line p-3">
      <span className="type-label text-fg-muted">Plan</span>
      <span className="text-sm font-semibold">Ops Suite</span>
      <span className="type-caption text-fg-muted">Workforce + Business + Revenue Layer</span>
    </div>
  );
}
