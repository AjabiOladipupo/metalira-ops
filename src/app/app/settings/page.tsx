import { ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { canAccessHref, findNavItem } from "@/lib/nav";
import { getSession } from "@/server/identity/session";

import { RouteGate } from "../_shell/slots";

export const metadata: Metadata = { title: "Settings" };

const SECTIONS = [
  {
    href: "/app/settings/company",
    title: "Company",
    body: "Business details, logo, pay cycle, invoices and plan.",
  },
] as const;

/** Settings sections the viewer's role may open (company settings are owner and admin only). */
async function SettingsSections() {
  const session = await getSession();
  const role = session?.active?.role;
  const sections = role ? SECTIONS.filter((s) => canAccessHref(role, s.href)) : [];
  if (sections.length === 0) return null;
  return (
    <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] gap-3 p-0">
      {sections.map((section) => (
        <li key={section.href}>
          <Link
            href={section.href}
            className="flex items-center gap-4 rounded-xl border border-line p-5 text-foreground no-underline hover:bg-surface"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-base font-semibold">{section.title}</span>
              <span className="text-sm text-fg-muted">{section.body}</span>
            </span>
            <ChevronRight
              strokeWidth={1.75}
              className="size-5 shrink-0 text-fg-muted"
              aria-hidden
            />
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function Page() {
  const item = findNavItem("/app/settings");
  return (
    <RouteGate href="/app/settings">
      <PageHeader title={item.label} description={item.description} />
      <SettingsSections />
      <EmptyState message={item.empty} />
    </RouteGate>
  );
}
