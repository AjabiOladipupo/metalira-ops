import { ChevronLeft } from "lucide-react";
import Link from "next/link";

import { cn } from "@/lib/utils";

export interface BackTarget {
  /** The logical parent page, never browser history, so it works the same from a link or email. */
  href: string;
  /** The parent's name, read as "Back to <name>". */
  label: string;
}

/** Back arrow to the page's logical parent: a 44px touch target with a chevron. */
export function BackLink({ href, label, className }: BackTarget & { className?: string }) {
  return (
    <Link
      href={href}
      aria-label={`Back to ${label}`}
      data-testid="back-link"
      className={cn(
        "-ml-2.5 flex size-11 shrink-0 items-center justify-center rounded-lg text-foreground no-underline hover:bg-surface hover:text-foreground",
        className,
      )}
    >
      <ChevronLeft strokeWidth={1.75} className="size-[22px]" aria-hidden />
    </Link>
  );
}
