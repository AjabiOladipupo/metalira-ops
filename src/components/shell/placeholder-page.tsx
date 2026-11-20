import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import type { Modules } from "@/lib/modules";
import { NAV, findNavItem, homeCopy } from "@/lib/nav";

/**
 * Holding page for a route whose feature arrives in a later phase. Copy lives in src/lib/nav.ts.
 * Home passes the company's `modules`, so its copy never points at a part that is switched off.
 */
export function PlaceholderPage({ href, modules }: { href: string; modules?: Modules }) {
  const navItem = findNavItem(href);
  const item = href === "/app" && modules ? { ...navItem, ...homeCopy(modules) } : navItem;
  const group = NAV.find((g) => g.items.includes(navItem))?.label ?? undefined;

  return (
    <>
      <PageHeader
        // The dashboard is home: no arrow there.
        back={href === "/app" ? undefined : { href: "/app", label: "dashboard" }}
        eyebrow={group && group !== item.label ? group : undefined}
        title={item.label}
        description={item.description}
      />
      <EmptyState message={item.empty} />
    </>
  );
}
