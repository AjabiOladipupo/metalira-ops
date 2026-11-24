import { ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { canAccessHref, findNavItem } from "@/lib/nav";
import { getActiveCompany } from "@/server/identity/company-data";
import { getPageSession } from "@/server/identity/session";

import { RouteGate } from "../_shell/slots";

export const metadata: Metadata = { title: "Settings" };

const SECTIONS = [
  {
    href: "/app/settings/company",
    title: "Company",
    body: "Business details, logo, pay cycle, invoices, modules and plan.",
  },
  {
    href: "/app/settings/bank-account",
    title: "Where clients pay",
    body: "Your business bank account on invoices, with approvals and history.",
  },
  {
    href: "/app/settings/team",
    title: "Team",
    body: "Invite managers, change their roles and remove access.",
  },
  {
    href: "/app/settings/departments",
    title: "Departments",
    body: "Add and rename departments and set who heads each one.",
  },
  {
    href: "/app/settings/leave",
    title: "Leave",
    body: "Leave types, days a year and pay, from a preset or your own.",
  },
  {
    href: "/app/settings/holidays",
    title: "Holidays",
    body: "Public holidays and the working week that leave counts.",
  },
  {
    href: "/app/settings/payroll",
    title: "Payroll rules",
    body: "PAYE bands, reliefs, pension, NHF and levies, as dated versions.",
  },
] as const;

/**
 * Settings sections the viewer's role may open (company and team: owner and admin; where clients pay:
 * also finance; departments, leave and holidays: also hr; payroll rules: owner, hr and finance).
 */
async function SettingsSections() {
  const [session, company] = await Promise.all([getPageSession(), getActiveCompany()]);
  const role = session?.active?.role;
  // Payroll rules belong to Payroll: hidden when the company has it off.
  const sections = role
    ? SECTIONS.filter((s) => canAccessHref(role, s.href, company?.modules))
    : [];
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
      <PageHeader
        back={{ href: "/app", label: "dashboard" }}
        title={item.label}
        description={item.description}
      />
      <SettingsSections />
      <EmptyState message={item.empty} />
    </RouteGate>
  );
}
