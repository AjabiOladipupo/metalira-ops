import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { formatPageRange, type PageWindow } from "@/lib/pagination";
import { cn } from "@/lib/utils";

function PageLink({
  href,
  label,
  direction,
}: {
  href: string | null;
  label: string;
  direction: "previous" | "next";
}) {
  const icon =
    direction === "previous" ? (
      <ChevronLeft strokeWidth={1.75} aria-hidden />
    ) : (
      <ChevronRight strokeWidth={1.75} aria-hidden />
    );
  const content =
    direction === "previous" ? (
      <>
        {icon}
        <span>{label}</span>
      </>
    ) : (
      <>
        <span>{label}</span>
        {icon}
      </>
    );
  if (!href) {
    return (
      <Button variant="outline" disabled aria-disabled className="h-11 px-3">
        {content}
      </Button>
    );
  }
  return (
    <Button asChild variant="outline" className="h-11 px-3 text-foreground no-underline">
      <Link href={href} rel={direction === "previous" ? "prev" : "next"} scroll={false}>
        {content}
      </Link>
    </Button>
  );
}

/**
 * Count, page size and previous/next under a long table: "1–25 of 162". Links are built on the
 * server, so they keep the search and filters and work without JavaScript.
 */
export function Pagination({
  pages,
  hrefFor,
  sizePicker,
  label,
  className,
}: {
  pages: PageWindow;
  /** Link to a page number, keeping everything else in the URL. */
  hrefFor: (page: number) => string;
  /** Usually a <PageSizeSelect>. */
  sizePicker?: React.ReactNode;
  /** Accessible name for the nav, e.g. "Employees pages". */
  label: string;
  className?: string;
}) {
  return (
    <nav
      aria-label={label}
      className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-3", className)}
    >
      <p className="m-0 text-sm text-fg-muted tabular-nums" data-testid="page-range">
        {formatPageRange(pages)}
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        {sizePicker}
        <div className="flex items-center gap-2">
          <PageLink
            direction="previous"
            label="Previous"
            href={pages.hasPrevious ? hrefFor(pages.page - 1) : null}
          />
          <PageLink
            direction="next"
            label="Next"
            href={pages.hasNext ? hrefFor(pages.page + 1) : null}
          />
        </div>
      </div>
    </nav>
  );
}
