import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { NAV, findNavItem } from "@/lib/nav";

/** Holding page for a route whose feature arrives in a later phase. Copy lives in src/lib/nav.ts. */
export function PlaceholderPage({ href }: { href: string }) {
  const item = findNavItem(href);
  const group = NAV.find((g) => g.items.includes(item))?.label ?? undefined;

  return (
    <>
      <PageHeader
        eyebrow={group && group !== item.label ? group : undefined}
        title={item.label}
        description={item.description}
      />
      <EmptyState message={item.empty} />
    </>
  );
}
