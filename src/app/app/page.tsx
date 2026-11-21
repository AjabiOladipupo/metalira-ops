import { ChevronRight, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PlaceholderPage } from "@/components/shell/placeholder-page";
import { getActiveCompany, pendingSetupHref } from "@/server/identity/company-data";
import { getPageSession } from "@/server/identity/session";

import { RouteGate } from "./_shell/slots";

export const metadata: Metadata = { title: "Home" };

/** An owner or admin whose company has not finished setup lands on the wizard instead. */
async function Home() {
  const setupHref = await pendingSetupHref();
  if (setupHref) redirect(setupHref);
  const [company, session] = await Promise.all([getActiveCompany(), getPageSession()]);
  // Line managers clock in their crew from the worker app (slice 3.6).
  const crew = session?.active?.role === "line_manager" && company?.modules.shifts !== false;
  return (
    <>
      {crew ? (
        <Link
          href="/m/crew"
          data-testid="crew-link"
          className="mx-4 mt-4 flex min-h-14 items-center gap-3 rounded-xl border border-line px-4 py-3 text-foreground no-underline hover:bg-surface hover:text-foreground md:mx-8"
        >
          <Users strokeWidth={1.75} className="size-5 shrink-0" aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-semibold">Clock in crew</span>
            <span className="text-[13px] text-fg-muted">
              Mark your team present or clocked out at their site.
            </span>
          </span>
          <ChevronRight strokeWidth={1.75} className="size-4 shrink-0 text-fg-muted" aria-hidden />
        </Link>
      ) : null}
      <PlaceholderPage href="/app" modules={company?.modules} />
    </>
  );
}

export default function Page() {
  return (
    <RouteGate href="/app">
      <Home />
    </RouteGate>
  );
}
