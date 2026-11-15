import Link from "next/link";

import { cn } from "@/lib/utils";

type KpiTileProps = {
  label: string;
  value: string;
  /** Delta or context in words, e.g. "vs ₦13.10m same point in Sep". */
  note?: string;
  href?: string;
  /** outline: needs attention tiles; filled: period summary tiles on surface. */
  variant?: "outline" | "filled";
  className?: string;
};

export function KpiTile({
  label,
  value,
  note,
  href,
  variant = "outline",
  className,
}: KpiTileProps) {
  const classes = cn(
    "flex flex-col gap-1.5 rounded-lg border p-4 text-foreground no-underline transition-colors",
    variant === "outline" ? "border-line bg-background" : "border-surface bg-surface",
    href && "hover:border-foreground hover:text-foreground",
    className,
  );
  const body = (
    <>
      <span className="type-label text-fg-muted">{label}</span>
      <span className="type-kpi">{value}</span>
      {note ? <span className="type-caption text-fg-muted">{note}</span> : null}
    </>
  );

  return href ? (
    <Link href={href} className={classes}>
      {body}
    </Link>
  ) : (
    <div className={classes}>{body}</div>
  );
}
